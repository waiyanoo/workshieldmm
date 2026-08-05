/**
 * The two controls that make a Tier A result defensible.
 *
 * A verification result is a factual claim about a named person, sold to an
 * employer who will act on it. Two rules stop it being an opinion:
 *
 *   1. The company must confirm the person authorised the check. Without that,
 *      the platform is looking people up because someone typed an NRC.
 *   2. The reviewer must record the source they actually contacted, and that
 *      source's answer must agree with the outcome published. Without that,
 *      "Employment record confirmed" is a reviewer's say-so.
 *
 * The happy path is covered in tierA.test.ts. What is pinned here is the
 * refusals — the cases where the platform must decline to produce a record —
 * because those are the ones that quietly stop working.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

let app: Express;
let pool: typeof import("../db/pool").pool;
let withContext: typeof import("../db/pool").withContext;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
});

afterAll(async () => {
  await Promise.allSettled([pool.end(), redis.quit()]);
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
  return { companyId, token };
}

async function raiseCheck(token: string, fullName: string): Promise<string> {
  const res = await request(app)
    .post("/verifications")
    .set("Authorization", `Bearer ${token}`)
    .send({
      subject: { fullName, nationalId: helpers.uniq("12/ABC(N)1") },
      authorization: helpers.verificationAuthorization(),
    })
    .expect(201);
  return res.body.id as string;
}

describe("verification authorization", () => {
  it("will not open a check without the company confirming consent", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const subject = { fullName: "Unconsented Person", nationalId: helpers.uniq("12/ABC(N)1") };

    // Omitted entirely.
    const missing = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject });
    expect(missing.status).toBe(400);

    // Present but not affirmed. `confirmed` is a literal true precisely so that
    // an unticked box cannot be sent as a value the server quietly accepts.
    const denied = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject, authorization: { confirmed: false } });
    expect(denied.status).toBe(400);

    // Nothing was created for that person by the failed attempts.
    const mine = await request(app)
      .get("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(
      mine.body.items.some((i: { subjectName?: string }) => i.subjectName === "Unconsented Person")
    ).toBe(false);
  });

  it("records the basis and the moment it was confirmed, and never as legacy", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const id = await raiseCheck(token, "Consented Person");

    const row = await withContext({ userType: "platform" }, (c) =>
      c.query<{ authorization_basis: string; authorization_confirmed_at: string | null }>(
        `SELECT authorization_basis, authorization_confirmed_at
           FROM verification_requests WHERE id = $1`,
        [id]
      )
    );
    expect(row.rows[0]!.authorization_basis).toBe("employee_consent");
    expect(row.rows[0]!.authorization_confirmed_at).toBeTruthy();

    // The reviewer sees that this check rests on a real confirmation rather
    // than on the pre-control default, which is what `legacy_no_record` means.
    const context = await request(app)
      .get(`/admin/verifications/${id}/context`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(context.body.consent.isLegacy).toBe(false);
    expect(context.body.consent.confirmedAt).toBeTruthy();
  });
});

describe("verification sources", () => {
  it("will not decide a check without naming a source", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const id = await raiseCheck(token, "Needs A Source");

    const noSource = await request(app)
      .post(`/admin/verifications/${id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "completed" });
    expect(noSource.status).toBe(400);

    // A half-filled source is no better than none: who was contacted and how
    // are the parts that make the record checkable later.
    const partial = await request(app)
      .post(`/admin/verifications/${id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "completed", source: { sourceCompany: "Someone" } });
    expect(partial.status).toBe(400);

    // Still open, so a refused decision has not half-decided anything.
    const still = await request(app)
      .get(`/admin/verifications?status=pending&q=Needs A Source`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(still.body.items.some((i: { id: string }) => i.id === id)).toBe(true);
  });

  it("refuses an outcome its source does not support", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    // Publishing "employment confirmed" on the back of a source that could not
    // confirm it is the single most damaging thing this system could do.
    const overclaim = await raiseCheck(token, "Overclaim Case");
    for (const response of ["no_record", "unable_to_confirm"] as const) {
      const res = await request(app)
        .post(`/admin/verifications/${overclaim}/decision`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          status: "completed",
          source: { ...helpers.verificationSource(), response },
        });
      expect(res.status, response).toBe(400);
    }

    // And the reverse: a source that confirmed employment cannot be filed as
    // "no record found".
    const underclaim = await raiseCheck(token, "Underclaim Case");
    const wrongWay = await request(app)
      .post(`/admin/verifications/${underclaim}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "not_found", source: helpers.verificationSource("employment_confirmed") });
    expect(wrongWay.status).toBe(400);

    // "Unable to confirm" is a legitimate not_found: the reviewer tried and got
    // nowhere, which is a different claim from "this person never worked there"
    // but is honestly reported as no record on file.
    const honest = await request(app)
      .post(`/admin/verifications/${underclaim}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "not_found",
        source: { ...helpers.verificationSource(), response: "unable_to_confirm" },
      });
    expect(honest.status).toBe(200);
  });

  it("keeps the source attributable to the reviewer who decided", async () => {
    const superToken = await loginPlatform(await helpers.createSuperAdmin());
    const reviewer = await helpers.createPlatformUser("admin_reviewer");
    const reviewerToken = await loginPlatform(reviewer);
    const { token } = await provisionCompany(superToken);
    const id = await raiseCheck(token, "Attributed Case");

    await request(app)
      .post(`/admin/verifications/${id}/decision`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({
        status: "completed",
        source: {
          ...helpers.verificationSource(),
          sourceCompany: "Golden Dragon Manufacturing",
          contactName: "Daw Aye Aye",
          contactMethod: "email",
          employmentStartDate: "2021-03-01",
          employmentEndDate: "2024-11-30",
        },
      })
      .expect(200);

    const context = await request(app)
      .get(`/admin/verifications/${id}/context`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(200);

    expect(context.body.sources).toHaveLength(1);
    expect(context.body.sources[0]).toMatchObject({
      sourceCompany: "Golden Dragon Manufacturing",
      contactName: "Daw Aye Aye",
      contactMethod: "email",
      response: "employment_confirmed",
      employmentStartDate: "2021-03-01",
      employmentEndDate: "2024-11-30",
    });
    // Named, not anonymous: a factual claim traces to the person who made it.
    expect(context.body.sources[0].reviewerName).toBeTruthy();
    expect(context.body.sources[0].verifiedAt).toBeTruthy();

    // The company sees the outcome; the reviewer's contact notes are internal.
    const asCompany = await request(app)
      .get("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const row = asCompany.body.items.find((i: { id: string }) => i.id === id);
    expect(row.status).toBe("completed");
    expect(JSON.stringify(row)).not.toContain("Daw Aye Aye");
  });
});
