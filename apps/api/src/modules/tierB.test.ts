/**
 * Tier B end-to-end integration test.
 *
 * Runs with FEATURE_TIER_B_ENABLED=true (set before the app is imported).
 * Exercises the evidence-gated lifecycle and its controls:
 *
 *   draft → evidence → submit → admin accept (publishes) → access request
 *     → cross-company read (audited) → withdraw (correction path) → expiry
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.FEATURE_TIER_B_ENABLED = "true";

let app: Express;
let pool: typeof import("../db/pool").pool;
let withContext: typeof import("../db/pool").withContext;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");
let lifecycle: typeof import("../jobs/lifecycle");
let closeQueues: typeof import("../jobs/queues").closeQueues;

beforeAll(async () => {
  const appMod = await import("../app");
  app = appMod.createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
  lifecycle = await import("../jobs/lifecycle");
  ({ closeQueues } = await import("../jobs/queues"));
});

afterAll(async () => {
  await Promise.allSettled([closeQueues(), pool.end(), redis.quit()]);
});

const PDF = Buffer.from("%PDF-1.4 evidence");

async function provisionTierBCompany(adminToken: string) {
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
  await request(app)
    .post(`/admin/companies/${companyId}/subscriptions`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ tier: "B" });

  return { companyId, token };
}

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Push a report to published via draft → evidence → submit → accept. */
async function publishReport(
  companyToken: string,
  adminToken: string,
  nationalId: string
): Promise<string> {
  const draft = await request(app)
    .post("/reports")
    .set("Authorization", `Bearer ${companyToken}`)
    .send({
      subject: { fullName: "Test Subject", nationalId, dateOfBirth: "1990-04-11" },
      categoryKey: "theft_fraud_misuse",
      narrativeSummary: "Confirmed theft of inventory, police report on file.",
    });
  expect(draft.status).toBe(201);
  const reportId: string = draft.body.id;

  await request(app)
    .post(`/reports/${reportId}/evidence`)
    .set("Authorization", `Bearer ${companyToken}`)
    .attach("file", PDF, { filename: "police-report.pdf", contentType: "application/pdf" })
    .expect(201);
  await request(app)
    .post(`/reports/${reportId}/submit`)
    .set("Authorization", `Bearer ${companyToken}`)
    .send({ declaration: { accepted: true, version: "2026-08" } })
    .expect(200);

  const decision = await request(app)
    .post(`/admin/reports/${reportId}/decision`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ decision: "evidence_sufficient", notes: "Police report checks out" });
  expect(decision.status).toBe(200);
  expect(decision.body.status).toBe("approved"); // acceptance publishes directly
  expect(decision.body.expiryDate).toBeTruthy();
  return reportId;
}

describe("Tier B conduct reports", () => {
  it("accepts on strong evidence, publishes on acceptance, and gates cross-company reads", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);
    const nationalId = `TIERB-${Date.now()}`;

    // Excluded (protected-activity) category is refused.
    const excluded = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${companyToken}`)
      .send({
        subject: { fullName: "Test Subject", nationalId },
        categoryKey: "political_affiliation",
        narrativeSummary: "should never be accepted",
      });
    expect(excluded.status).toBe(400);

    // The reviewed policy has eight specific, evidence-gated eligible reasons.
    const cats = await request(app)
      .get("/report-categories")
      .set("Authorization", `Bearer ${companyToken}`);
    expect(cats.body.items).toHaveLength(8);

    // Submission without evidence is refused.
    const draft = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${companyToken}`)
      .send({
        subject: { fullName: "Test Subject", nationalId },
        categoryKey: "theft_fraud_misuse",
        narrativeSummary: "Confirmed theft of inventory.",
      });
    const draftId: string = draft.body.id;
    const noEvidence = await request(app)
      .post(`/reports/${draftId}/submit`)
      .set("Authorization", `Bearer ${companyToken}`);
    expect(noEvidence.status).toBe(400);

    // A draft is not discoverable — only published reports are.
    const other = await provisionTierBCompany(adminToken);
    const earlySearch = await request(app)
      .post("/access-requests")
      .set("Authorization", `Bearer ${other.token}`)
      .send({ subject: { nationalId } });
    expect(earlySearch.status).toBe(201);
    expect(earlySearch.body.items).toHaveLength(0);

    // Full publish flow on a fresh report.
    const reportId = await publishReport(companyToken, adminToken, `${nationalId}-B`);

    // Now discoverable, and the access request is required to read content.
    const search = await request(app)
      .post("/access-requests")
      .set("Authorization", `Bearer ${other.token}`)
      .send({ subject: { nationalId: `${nationalId}-B` } });
    expect(search.status).toBe(201);
    expect(search.body.items).toHaveLength(1);
    const accessRequestId: string = search.body.items[0].accessRequestId;

    const early = await request(app)
      .get(`/reports/${reportId}`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(early.status).toBe(403);

    // Reading another employer's report costs 15 credits and a new account has
    // only the 10 welcome ones, so top the reader up first. (Pricing Plan §4)
    await request(app)
      .post(`/admin/companies/${other.companyId}/credits`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 100, reason: "test fixture" })
      .expect(200);

    await request(app)
      .post(`/access-requests/${accessRequestId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "approved" })
      .expect(200);
    const read = await request(app)
      .get(`/reports/${reportId}`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(read.status).toBe(200);
    expect(read.body.categoryName).toBe("Theft, fraud, or misuse of company money/property");
    const accessAudit = await pool.query(
      `SELECT 1 FROM audit.audit_logs WHERE action = 'report.access' AND resource_id = $1`,
      [reportId]
    );
    expect(accessAudit.rowCount).toBeGreaterThan(0);

    // Correction path: withdraw makes it un-discoverable again.
    const withdraw = await request(app)
      .post(`/admin/reports/${reportId}/withdraw`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Subject provided evidence the record was mistaken" });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.status).toBe("withdrawn");
    const afterWithdraw = await request(app)
      .get(`/reports/${reportId}`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(afterWithdraw.status).toBe(404);
  });

  it("lets the filer see and withdraw its own report, reversing the earned credits", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);
    const reportId = await publishReport(companyToken, adminToken, `OWN-${Date.now()}`);

    // The filer can read back everything they submitted, free of charge.
    const detail = await request(app)
      .get(`/reports/${reportId}`)
      .set("Authorization", `Bearer ${companyToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.isOwn).toBe(true);
    expect(detail.body.subjectName).toBe("Test Subject");
    expect(detail.body.subjectNationalId).toContain("OWN-");
    expect(detail.body.categoryName).toBe("Theft, fraud, or misuse of company money/property");
    expect(detail.body.evidence).toHaveLength(1);

    // Withdrawing requires a reason and needs no admin.
    const noReason = await request(app)
      .post(`/reports/${reportId}/withdraw`)
      .set("Authorization", `Bearer ${companyToken}`)
      .send({});
    expect(noReason.status).toBe(400);

    const withdrawn = await request(app)
      .post(`/reports/${reportId}/withdraw`)
      .set("Authorization", `Bearer ${companyToken}`)
      .send({ reason: "Filed against the wrong person" });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");
    // The acceptance reward is clawed back, so file-accept-withdraw cannot farm credits.
    expect(withdrawn.body.creditsReversed).toBe(10);

    // Withdrawing twice is refused.
    const again = await request(app)
      .post(`/reports/${reportId}/withdraw`)
      .set("Authorization", `Bearer ${companyToken}`)
      .send({ reason: "again" });
    expect(again.status).toBe(409);
  });

  it("will not allow a withdrawn report back into circulation", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);
    const reportId = await publishReport(companyToken, adminToken, `FINAL-${Date.now()}`);

    await request(app)
      .post(`/reports/${reportId}/withdraw`)
      .set("Authorization", `Bearer ${companyToken}`)
      .send({ reason: "Retracted" })
      .expect(200);

    // Even bypassing the API entirely, the data layer refuses to un-withdraw it.
    await expect(
      withContext({ userType: "system" }, (client) =>
        client.query(`UPDATE conduct_reports SET status = 'approved' WHERE id = $1`, [reportId])
      )
    ).rejects.toThrow(/withdrawn and cannot be returned/i);
  });

  it("will not let one employer withdraw another employer's report", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);
    const reportId = await publishReport(companyToken, adminToken, `FOREIGN-${Date.now()}`);

    const other = await provisionTierBCompany(adminToken);
    const attempt = await request(app)
      .post(`/reports/${reportId}/withdraw`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ reason: "not mine to withdraw" });
    expect(attempt.status).toBe(404); // RLS hides it entirely — not even its existence

    const still = await withContext({ userType: "system" }, async (client) =>
      (await client.query(`SELECT status FROM conduct_reports WHERE id = $1`, [reportId])).rows[0]
    );
    expect(still.status).toBe("approved");
  });

  it("rejects a report when evidence is insufficient", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);

    const draft = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${companyToken}`)
      .send({
        subject: { fullName: "Weak Evidence", nationalId: `WEAK-${Date.now()}` },
        categoryKey: "safety_breach",
        narrativeSummary: "Alleged breach with thin documentation.",
      });
    const reportId: string = draft.body.id;
    await request(app)
      .post(`/reports/${reportId}/evidence`)
      .set("Authorization", `Bearer ${companyToken}`)
      .attach("file", PDF, { filename: "note.pdf", contentType: "application/pdf" })
      .expect(201);
    await request(app)
      .post(`/reports/${reportId}/submit`)
      .set("Authorization", `Bearer ${companyToken}`)
      .send({ declaration: { accepted: true, version: "2026-08" } })
      .expect(200);

    const rejected = await request(app)
      .post(`/admin/reports/${reportId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "evidence_insufficient", notes: "No signed record; reject" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");
  });

  it("returns attached evidence with the employer's own reports", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);

    const draft = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${companyToken}`)
      .send({
        subject: { fullName: "Evidence List", nationalId: `EV-${Date.now()}` },
        categoryKey: "theft_fraud_misuse",
        narrativeSummary: "Confirmed theft, signed investigation record attached.",
      });
    const reportId: string = draft.body.id;

    // Before upload the list shows the report with no evidence…
    const before = await request(app)
      .get("/reports")
      .set("Authorization", `Bearer ${companyToken}`);
    expect(before.body.items.find((r: { id: string }) => r.id === reportId).evidence).toHaveLength(0);

    await request(app)
      .post(`/reports/${reportId}/evidence`)
      .set("Authorization", `Bearer ${companyToken}`)
      .attach("file", PDF, { filename: "record.pdf", contentType: "application/pdf" })
      .expect(201);

    // …and after it, the uploaded file is visible with its metadata.
    const after = await request(app)
      .get("/reports")
      .set("Authorization", `Bearer ${companyToken}`);
    const listed = after.body.items.find((r: { id: string }) => r.id === reportId);
    expect(listed.evidence).toHaveLength(1);
    expect(listed.evidence[0].contentType).toBe("application/pdf");
    expect(listed.evidence[0].byteSize).toBeGreaterThan(0);
  });

  it("expires and anonymizes a published report past its retention date", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);
    const { token: companyToken } = await provisionTierBCompany(adminToken);
    const reportId = await publishReport(companyToken, adminToken, `EXP-${Date.now()}`);

    await withContext({ userType: "system" }, (client) =>
      client.query(`UPDATE conduct_reports SET expiry_date = now() - interval '1 day' WHERE id = $1`, [
        reportId,
      ])
    );
    const expired = await lifecycle.expireReports();
    expect(expired).toContain(reportId);

    const after = await withContext({ userType: "system" }, async (client) => {
      const r = await client.query(
        `SELECT status, narrative_summary,
                (SELECT count(*) FROM evidence_files e WHERE e.report_id = $1) AS evidence
           FROM conduct_reports WHERE id = $1`,
        [reportId]
      );
      return r.rows[0];
    });
    expect(after.status).toBe("expired");
    expect(after.narrative_summary).toBeNull();
    expect(Number(after.evidence)).toBe(0);
  });
});
