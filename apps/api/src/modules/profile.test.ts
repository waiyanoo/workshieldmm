/**
 * Profile self-service.
 *
 * The tests that matter are the negative ones: a company must not be able to
 * edit its way out of the identity it was verified under, and a regular user
 * must not be able to change organisation-level details.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

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

const PDF = Buffer.from("%PDF-1.4 doc");

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function provisionCompany(adminToken: string) {
  const reg = await request(app).post("/companies").send(helpers.companyRegistrationPayload());
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
  return { companyId, token, legalName: reg.body.company.legalName };
}

describe("profile", () => {
  it("lets a company admin maintain contact details", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const before = await request(app).get("/profile").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.company.phone).toBeNull();
    expect(before.body.lockedFields).toContain("legalName");

    const saved = await request(app)
      .patch("/profile/company")
      .set("Authorization", `Bearer ${token}`)
      .send({
        phone: "09 771 234 567",
        contactEmail: "office@example.test",
        addressLine: "No. 12, Bo Aung Kyaw Street",
        township: "Kyauktada",
        city: "Yangon",
        region: "Yangon Region",
      });
    expect(saved.status).toBe(200);
    expect(saved.body.phone).toBe("09 771 234 567");
    expect(saved.body.city).toBe("Yangon");

    // Editing one field must not wipe the others.
    const onlyPhone = await request(app)
      .patch("/profile/company")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "09 999 000 111" });
    expect(onlyPhone.status).toBe(200);
    expect(onlyPhone.body.phone).toBe("09 999 000 111");
    expect(onlyPhone.body.city).toBe("Yangon");
    expect(onlyPhone.body.addressLine).toContain("Bo Aung Kyaw");
  });

  it("refuses to let a company edit its verified identity", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token, legalName } = await provisionCompany(adminToken);

    // Rejected by the schema — unknown fields are refused, not ignored, so a
    // caller cannot smuggle an identity change through the contact endpoint.
    for (const body of [
      { legalName: "Totally Different Co" },
      { registrationNumber: "DICA-FAKE-1" },
      { status: "verified" },
      { plan: "growth" },
    ]) {
      const res = await request(app)
        .patch("/profile/company")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
    }

    const after = await withContext({ userType: "system" }, async (c) =>
      (await c.query(`SELECT legal_name, plan FROM companies WHERE id = $1`, [companyId])).rows[0]
    );
    expect(after.legal_name).toBe(legalName);
    expect(after.plan).toBe("free");
  });

  it("blocks an identity change at the data layer even if the API is bypassed", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId } = await provisionCompany(adminToken);

    // Acting in the company's own RLS context, as a compromised request would.
    await expect(
      withContext({ userType: "company", companyId }, (c) =>
        c.query(`UPDATE companies SET legal_name = 'Renamed Co' WHERE id = $1`, [companyId])
      )
    ).rejects.toThrow(/verified identity/i);

    // Platform staff can still correct it — the lock is on the company only.
    await expect(
      withContext({ userType: "platform" }, (c) =>
        c.query(`UPDATE companies SET legal_name = 'Corrected Co' WHERE id = $1`, [companyId])
      )
    ).resolves.toBeDefined();
  });

  it("keeps company details out of reach of a non-admin user", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);

    // A second, non-admin user in the same company.
    const password = "Str0ngPass!";
    const email = helpers.uniq("staff") + "@example.com";
    await withContext({ userType: "system" }, async (c) => {
      await c.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
      const { hashPassword } = await import("./auth/password");
      await c.query(
        `INSERT INTO company_users (company_id, full_name, email, role, password_hash)
         VALUES ($1, 'Staff Member', $2, 'company_user', $3)`,
        [companyId, email, await hashPassword(password)]
      );
    });
    const staff = await request(app).post("/auth/login").send({ email, password });
    expect(staff.status).toBe(200);
    const staffToken = staff.body.accessToken as string;

    // They can see the profile…
    const view = await request(app).get("/profile").set("Authorization", `Bearer ${staffToken}`);
    expect(view.status).toBe(200);

    // …but not change organisation-level details.
    const attempt = await request(app)
      .patch("/profile/company")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ phone: "09 000 000 000" });
    expect(attempt.status).toBe(403);

    // Their own details are theirs to change.
    const own = await request(app)
      .patch("/profile/me")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ fullName: "Staff Member Updated", phone: "09 123 456 789" });
    expect(own.status).toBe(200);
    expect(own.body.fullName).toBe("Staff Member Updated");

    // The sign-in email is not editable from the profile screen at all.
    const emailChange = await request(app)
      .patch("/profile/me")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ email: "attacker@example.test" });
    expect(emailChange.status).toBe(400);
  });
});
