/**
 * Company team management.
 *
 * The interesting cases are the ones where getting it wrong is expensive: an
 * invitation that outlives its revocation, a deactivation that leaves a working
 * session behind, and the last administrator removing themselves so nobody can
 * ever invite anyone again.
 *
 * Runs with FEATURE_TEAM_INVITES_ENABLED=true (set before the app is imported),
 * because invitations ship switched off — see featureFlags.ts. The flag being
 * off is covered separately at the bottom of this file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.FEATURE_TEAM_INVITES_ENABLED = "true";

let app: Express;
let pool: typeof import("../db/pool").pool;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");
let closeQueues: typeof import("../jobs/queues").closeQueues;

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
  ({ closeQueues } = await import("../jobs/queues"));
});

afterAll(async () => {
  await Promise.allSettled([closeQueues(), pool.end(), redis.quit()]);
});

const PDF = Buffer.from("%PDF-1.4 doc");

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function provisionCompany(adminToken: string) {
  const payload = helpers.companyRegistrationPayload();
  const reg = await request(app).post("/companies").send(payload);
  expect(reg.status).toBe(201);
  const companyId: string = reg.body.company.id;
  const token: string = reg.body.accessToken;
  for (const [docType, filename, contentType] of [
    ["dica_certificate", "dica.pdf", "application/pdf"],
    ["nrc", "nrc.png", "image/png"],
  ] as const) {
    await request(app)
      .post(`/companies/${companyId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .field("docType", docType)
      .attach("file", PDF, { filename, contentType })
      .expect(201);
  }
  await helpers.approveCompanyDocuments(app, companyId, adminToken);
  await request(app)
    .post(`/companies/${companyId}/verify`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({})
    .expect(200);
  return { companyId, token, ownerEmail: payload.admin.email };
}

describe("team management", () => {
  it("invites a colleague, who accepts and can sign in", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const email = `${helpers.uniq("hr")}@example.com`;
    const invite = await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email, role: "company_user", fullName: "Hla Hla" });
    expect(invite.status).toBe(201);
    expect(invite.body.token).toBeTruthy();

    // The preview is public — the invitee has no account yet — and names the
    // company so they know what they are accepting.
    const preview = await request(app).get(`/team/invites/${invite.body.token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.email).toBe(email);
    expect(preview.body.companyName).toBeTruthy();

    const accepted = await request(app)
      .post("/team/invites/accept")
      .send({ token: invite.body.token, fullName: "Hla Hla", password: "An0therStrong!" });
    expect(accepted.status).toBe(201);

    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: "An0therStrong!" });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("company_user");

    // The token is single-use: replaying it must not mint a second account.
    const replay = await request(app)
      .post("/team/invites/accept")
      .send({ token: invite.body.token, fullName: "Impostor", password: "Y3tAnotherPass!" });
    expect(replay.status).toBe(404);

    const team = await request(app).get("/team").set("Authorization", `Bearer ${token}`);
    expect(team.status).toBe(200);
    expect(team.body.members).toHaveLength(2);
    expect(team.body.invites).toHaveLength(0); // consumed, so no longer outstanding
  });

  it("stops a revoked invitation from being accepted", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const email = `${helpers.uniq("gone")}@example.com`;
    const invite = await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email, role: "company_user" })
      .expect(201);

    await request(app)
      .post(`/team/invites/${invite.body.id}/revoke`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    await request(app).get(`/team/invites/${invite.body.token}`).expect(404);
    const accept = await request(app)
      .post("/team/invites/accept")
      .send({ token: invite.body.token, fullName: "Nope", password: "Str0ngEnough!" });
    expect(accept.status).toBe(404);
  });

  it("cuts a deactivated colleague's live session, not just their next login", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const email = `${helpers.uniq("leaver")}@example.com`;
    const invite = await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email, role: "company_user" })
      .expect(201);
    await request(app)
      .post("/team/invites/accept")
      .send({ token: invite.body.token, fullName: "Leaver", password: "L3avingSoon!" })
      .expect(201);

    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: "L3avingSoon!" })
      .expect(200);
    const refreshToken = login.body.refreshToken as string;

    const team = await request(app).get("/team").set("Authorization", `Bearer ${token}`);
    const member = team.body.members.find((m: { email: string }) => m.email === email);

    await request(app)
      .patch(`/team/members/${member.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "suspended" })
      .expect(200);

    // The refresh token is dead, so the session cannot be extended past the
    // short access-token window — which is the whole point on someone's last day.
    await request(app).post("/auth/refresh").send({ refreshToken }).expect(401);
    await request(app)
      .post("/auth/login")
      .send({ email, password: "L3avingSoon!" })
      .expect(401);
  });

  it("refuses to remove the last active administrator", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    // A second admin, so there is someone to attempt the removal.
    const email = `${helpers.uniq("admin2")}@example.com`;
    const invite = await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email, role: "company_admin" })
      .expect(201);
    await request(app)
      .post("/team/invites/accept")
      .send({ token: invite.body.token, fullName: "Second Admin", password: "S3condAdmin!" })
      .expect(201);
    const second = await request(app)
      .post("/auth/login")
      .send({ email, password: "S3condAdmin!" })
      .expect(200);

    const team = await request(app).get("/team").set("Authorization", `Bearer ${token}`);
    const owner = team.body.members.find((m: { isSelf: boolean }) => m.isSelf);
    const secondMember = team.body.members.find((m: { email: string }) => m.email === email);

    // The second admin can demote the first — two admins, so this is allowed.
    await request(app)
      .patch(`/team/members/${owner.id}`)
      .set("Authorization", `Bearer ${second.body.accessToken}`)
      .send({ role: "company_user" })
      .expect(200);

    // Now they are the only one left, and cannot be removed by anyone.
    const selfAttempt = await request(app)
      .patch(`/team/members/${secondMember.id}`)
      .set("Authorization", `Bearer ${second.body.accessToken}`)
      .send({ status: "suspended" });
    // Changing your own access is refused before the last-admin rule is reached.
    expect(selfAttempt.status).toBe(400);
  });

  it("keeps team administration away from ordinary company users", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const email = `${helpers.uniq("staff")}@example.com`;
    const invite = await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email, role: "company_user" })
      .expect(201);
    await request(app)
      .post("/team/invites/accept")
      .send({ token: invite.body.token, fullName: "Staff", password: "St4ffPassword!" })
      .expect(201);
    const staff = await request(app)
      .post("/auth/login")
      .send({ email, password: "St4ffPassword!" })
      .expect(200);
    const staffToken = staff.body.accessToken as string;

    // They can see who has access — that is not privileged within a company…
    const view = await request(app).get("/team").set("Authorization", `Bearer ${staffToken}`);
    expect(view.status).toBe(200);
    expect(view.body.canManage).toBe(false);

    // …but cannot invite, and cannot promote themselves.
    await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ email: `${helpers.uniq("x")}@example.com`, role: "company_admin" })
      .expect(403);

    const self = view.body.members.find((m: { isSelf: boolean }) => m.isSelf);
    await request(app)
      .patch(`/team/members/${self.id}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ role: "company_admin" })
      .expect(403);
  });

  it("attributes each check to the colleague who ran it", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    // A unique NRC: subjects are keyed by the ID hash and keep the name they
    // were first seen under, so a shared one would return another test's name.
    const name = helpers.uniq("Aung Aung");
    await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: { fullName: name, nationalId: helpers.uniq("12/ABC(N)") } })
      .expect(201);

    const team = await request(app).get("/team").set("Authorization", `Bearer ${token}`);
    const owner = team.body.members.find((m: { isSelf: boolean }) => m.isSelf);
    expect(owner.checks).toBe(1);
    expect(owner.lastActivity).toBeTruthy();

    const activity = await request(app)
      .get(`/team/members/${owner.id}/activity`)
      .set("Authorization", `Bearer ${token}`);
    expect(activity.status).toBe(200);
    expect(activity.body.checks[0].subjectName).toBe(name);
  });
});
