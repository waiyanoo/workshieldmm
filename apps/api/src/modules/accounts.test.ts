/**
 * Account administration.
 *
 * The claims worth pinning here are the ones that make admin-issued credentials
 * safe rather than convenient:
 *
 *   - a temporary password unlocks nothing except replacing itself;
 *   - resets and email changes kill the sessions that were already open;
 *   - an admin cannot use these endpoints on their own account;
 *   - the last Super Admin cannot be removed;
 *   - reviewers cannot reach any of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { authenticator } from "otplib";

let app: Express;
let pool: typeof import("../db/pool").pool;
let withContext: typeof import("../db/pool").withContext;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");
let closeQueues: typeof import("../jobs/queues").closeQueues;

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
  ({ closeQueues } = await import("../jobs/queues"));
});

afterAll(async () => {
  await Promise.allSettled([closeQueues(), pool.end(), redis.quit()]);
});

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

describe("account administration", () => {
  it("walks a brand new Super Admin from temporary password to working account", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const email = `${helpers.uniq("newsuper")}@hyper.local`;

    const created = await request(app)
      .post("/admin/accounts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "New Super Admin", email, role: "super_admin" });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);

    // Sign in. This used to REFUSE, which was a dead end: MFA enrolment needs a
    // session and there was no way to get one. It now issues a session that can
    // reach nothing but the two things still outstanding.
    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: created.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    expect(login.body.mfaSetupRequired).toBe(true);

    // Password first: MFA setup is closed until it is replaced.
    const tooSoon = await request(app)
      .post("/auth/mfa/setup")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(tooSoon.status).toBe(403);
    expect(tooSoon.body.error.code).toBe("password_change_required");

    // Refreshing must not be a way to shed either restriction.
    const refreshed = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    const claims = JSON.parse(
      Buffer.from(refreshed.body.accessToken.split(".")[1], "base64").toString()
    );
    expect(claims.mustChangePassword).toBe(true);
    expect(claims.mfaSetupRequired).toBe(true);

    const changed = await request(app)
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${refreshed.body.accessToken}`)
      .send({ currentPassword: created.body.temporaryPassword, newPassword: "RealSuper!2026" })
      .expect(200);

    // Password done, MFA still outstanding — and still enforced.
    const stillWalled = await request(app)
      .get("/admin/accounts")
      .set("Authorization", `Bearer ${changed.body.accessToken}`);
    expect(stillWalled.status).toBe(403);
    expect(stillWalled.body.error.code).toBe("mfa_setup_required");

    const setup = await request(app)
      .post("/auth/mfa/setup")
      .set("Authorization", `Bearer ${changed.body.accessToken}`)
      .expect(200);
    expect(setup.body.secret).toBeTruthy();
    // The QR is rendered server-side so the screen needs no internet access.
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // Asking again returns the SAME secret. The setup page calls this whenever
    // it opens — a reload, a re-render, React's double-invoked effects — and a
    // fresh secret each time would invalidate the QR already scanned, leaving
    // the user typing codes that can never be right.
    const again = await request(app)
      .post("/auth/mfa/setup")
      .set("Authorization", `Bearer ${changed.body.accessToken}`)
      .expect(200);
    expect(again.body.secret).toBe(setup.body.secret);

    const verified = await request(app)
      .post("/auth/mfa/verify")
      .set("Authorization", `Bearer ${changed.body.accessToken}`)
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);
    expect(verified.body.accessToken).toBeTruthy();

    // Enrolment hands back an unrestricted session, so there is no second
    // sign-in with a code the app has only just begun producing.
    await request(app)
      .get("/admin/accounts?limit=1")
      .set("Authorization", `Bearer ${verified.body.accessToken}`)
      .expect(200);

    // And a fresh sign-in now behaves like any other account.
    const relogin = await request(app)
      .post("/auth/login")
      .send({
        email,
        password: "RealSuper!2026",
        mfaCode: authenticator.generate(setup.body.secret),
      })
      .expect(200);
    expect(relogin.body.mustChangePassword).toBe(false);
    expect(relogin.body.mfaSetupRequired).toBe(false);

    // Once enrolled, re-running setup is refused rather than served: it would
    // overwrite the secret living in the authenticator app with one nobody has
    // scanned, locking the account out of itself. Clearing it is an admin action.
    const reEnrol = await request(app)
      .post("/auth/mfa/setup")
      .set("Authorization", `Bearer ${relogin.body.accessToken}`);
    expect(reEnrol.status).toBe(409);
    // The factor that already works still works.
    await request(app)
      .post("/auth/login")
      .send({
        email,
        password: "RealSuper!2026",
        mfaCode: authenticator.generate(setup.body.secret),
      })
      .expect(200);
  });

  it("closes every route until an admin-issued password is replaced", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());

    // A company user, because company logins do not force MFA and so reach a
    // session immediately — the cleanest way to exercise the gate itself.
    const reg = await request(app).post("/companies").send(helpers.companyRegistrationPayload());
    expect(reg.status).toBe(201);
    const userId: string = JSON.parse(
      Buffer.from(reg.body.accessToken.split(".")[1], "base64").toString()
    ).sub;

    const reset = await request(app)
      .post(`/admin/company-accounts/${userId}/reset-password`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reset.status).toBe(200);
    const temp: string = reset.body.temporaryPassword;

    // The session they already had is gone.
    await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${reg.body.accessToken}`)
      .expect(200); // access token still valid until it expires…
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: reg.body.refreshToken })
      .expect(401); // …but it cannot be renewed.

    const login = await request(app)
      .post("/auth/login")
      .send({ email: reset.body.email, password: temp });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);

    // That session can do nothing at all…
    const walled = await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(walled.status).toBe(403);
    expect(walled.body.error.code).toBe("password_change_required");

    // …except replace the password.
    const changed = await request(app)
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: temp, newPassword: "BrandNewPass!24" });
    expect(changed.status).toBe(200);

    // And the tokens it hands back are unrestricted.
    await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${changed.body.accessToken}`)
      .expect(200);

    // The temporary password is dead.
    await request(app)
      .post("/auth/login")
      .send({ email: reset.body.email, password: temp })
      .expect(401);
  });

  it("moves a login email and cuts the sessions opened under the old one", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const reg = await request(app).post("/companies").send(helpers.companyRegistrationPayload());
    const userId: string = JSON.parse(
      Buffer.from(reg.body.accessToken.split(".")[1], "base64").toString()
    ).sub;
    const newEmail = `${helpers.uniq("moved")}@example.com`;

    const updated = await request(app)
      .patch(`/admin/company-accounts/${userId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: newEmail });
    expect(updated.status).toBe(200);
    expect(updated.body.email).toBe(newEmail);

    // An email change is the classic takeover route, so the old session goes.
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: reg.body.refreshToken })
      .expect(401);

    // The new address is the login; the old one is gone.
    const listed = await request(app)
      .get(`/admin/company-accounts?q=${encodeURIComponent(newEmail)}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(listed.body.items[0].email).toBe(newEmail);
  });

  it("refuses to let an admin act on their own account", async () => {
    const superAdmin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(superAdmin);

    await request(app)
      .post(`/admin/accounts/${superAdmin.id}/reset-password`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);
    await request(app)
      .patch(`/admin/accounts/${superAdmin.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "suspended" })
      .expect(400);
    await request(app)
      .post(`/admin/accounts/${superAdmin.id}/reset-mfa`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);
  });

  it("will not leave the platform without an active Super Admin", async () => {
    const a = await helpers.createSuperAdmin();
    const aToken = await loginPlatform(a);
    const b = await helpers.createSuperAdmin();

    // While two exist, demoting one is allowed.
    await request(app)
      .patch(`/admin/accounts/${b.id}`)
      .set("Authorization", `Bearer ${aToken}`)
      .send({ role: "admin_reviewer" })
      .expect(200);

    // The rule is about the LAST active Super Admin, which is global state — so
    // exercising it means briefly being the only one. This runs against a
    // shared development database that contains real logins, so every account
    // stood down here is captured and put back in the `finally`, whatever the
    // assertions do. An earlier version left developers locked out of their own
    // super admin; it is not a hypothetical.
    const standDown = await withContext({ userType: "platform" }, (c) =>
      c.query<{ id: string }>(
        `UPDATE platform_users SET status = 'suspended'
          WHERE role = 'super_admin' AND status = 'active' AND id <> $1
          RETURNING id`,
        [a.id]
      )
    );
    const suspended = standDown.rows.map((r) => r.id);

    try {
      // `a` is now the only active Super Admin, and cannot be stood down.
      const refused = await request(app)
        .patch(`/admin/accounts/${a.id}`)
        .set("Authorization", `Bearer ${aToken}`)
        .send({ status: "suspended" });
      // Refused twice over: acting on your own account is blocked first, and
      // the last-Super-Admin rule would refuse it anyway.
      expect([400, 409]).toContain(refused.status);

      // Demoting the last one by role is refused for the same reason.
      const demoted = await request(app)
        .patch(`/admin/accounts/${a.id}`)
        .set("Authorization", `Bearer ${aToken}`)
        .send({ role: "admin_reviewer" });
      expect([400, 409]).toContain(demoted.status);
    } finally {
      if (suspended.length) {
        await withContext({ userType: "platform" }, (c) =>
          c.query(`UPDATE platform_users SET status = 'active' WHERE id = ANY($1::uuid[])`, [
            suspended,
          ])
        );
      }
    }
  });

  it("keeps account administration away from reviewers and companies", async () => {
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const reg = await request(app).post("/companies").send(helpers.companyRegistrationPayload());

    for (const token of [reviewerToken, reg.body.accessToken]) {
      await request(app).get("/admin/accounts").set("Authorization", `Bearer ${token}`).expect(403);
      await request(app)
        .get("/admin/company-accounts")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
      await request(app)
        .post("/admin/accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ fullName: "X", email: `${helpers.uniq("x")}@hyper.local`, role: "super_admin" })
        .expect(403);
    }
  });

  it("refuses a platform account on an email that already belongs to an employer", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const payload = helpers.companyRegistrationPayload();
    await request(app).post("/companies").send(payload).expect(201);

    // Reviewers must never be affiliated with a subscribing employer.
    const clash = await request(app)
      .post("/admin/accounts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "Conflicted", email: payload.admin.email, role: "admin_reviewer" });
    expect(clash.status).toBe(409);
  });
});
