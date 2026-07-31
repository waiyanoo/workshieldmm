/**
 * Conduct report review statistics.
 *
 * The figures that matter here are the ones an operator would act on, so the
 * ones worth pinning down are:
 *
 *   - the accepted share, which is the closest thing the platform has to a
 *     measure of whether employers are filing things the evidence supports;
 *   - turnaround measured from SUBMISSION, not from when the draft was opened,
 *     because the drafting time is the employer's and charging the review team
 *     for it makes the number worse the slower customers are;
 *   - withdrawals and expiries counted apart from rejections — all three end a
 *     report, only one of them is a review decision.
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

const PDF = Buffer.from("%PDF-1.4 evidence");

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function provisionTierBCompany(adminToken: string) {
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
  await request(app)
    .post(`/admin/companies/${companyId}/subscriptions`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ tier: "B" });
  return { companyId, token };
}

/**
 * Draft + evidence + submit. Left undecided so the caller chooses the ending.
 * Returns the NRC too — access is requested against the person, not the report.
 */
async function submitReport(companyToken: string) {
  const nationalId = helpers.uniq("12/RPT(N)");
  const draft = await request(app)
    .post("/reports")
    .set("Authorization", `Bearer ${companyToken}`)
    .send({
      subject: { fullName: "Stat Subject", nationalId, dateOfBirth: "1990-04-11" },
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
    .expect(200);
  return { reportId, nationalId };
}

function statsUrl(from: Date, to: Date) {
  const q = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    tzOffsetMinutes: "390",
  });
  return `/admin/stats?${q}`;
}

describe("report review statistics", () => {
  it("separates accepted, rejected and withdrawn, and reports the accepted share", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const from = new Date();
    const { token } = await provisionTierBCompany(adminToken);

    // Three accepted, one rejected → 75% of decided reports accepted.
    const accepted: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { reportId } = await submitReport(token);
      await request(app)
        .post(`/admin/reports/${reportId}/decision`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ decision: "evidence_sufficient", notes: "Evidence holds up." })
        .expect(200);
      accepted.push(reportId);
    }
    const rejected = await submitReport(token);
    await request(app)
      .post(`/admin/reports/${rejected.reportId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "evidence_insufficient", notes: "Only hearsay attached." })
      .expect(200);

    // One left undecided, so the queue figure has something in it.
    await submitReport(token);

    // And one published report withdrawn afterwards. A withdrawal ends a
    // report but is NOT a review decision, so it must not move the rate.
    await request(app)
      .post(`/reports/${accepted[0]}/withdraw`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "Employer found the record was mistaken." })
      .expect(200);

    const res = await request(app)
      .get(statsUrl(from, new Date(Date.now() + 60_000)))
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const r = res.body.reports;
    // Five submissions: three accepted, one rejected, one left pending. The
    // withdrawal below re-ends an already-counted report; it is not a sixth.
    expect(r.submitted).toBe(5);
    expect(r.accepted).toBe(3);
    expect(r.rejected).toBe(1);
    expect(r.decided).toBe(4);
    expect(r.acceptanceRate).toBe(75);
    expect(r.withdrawn).toBe(1);
    expect(r.pending).toBeGreaterThanOrEqual(1);

    // Categories and reviewers add up to the same decisions.
    const theft = r.byCategory.find(
      (c: { name: string }) => c.name === "Theft, fraud, or misuse of company money/property"
    );
    expect(theft.submitted).toBe(5);
    expect(theft.accepted).toBe(3);
    expect(theft.rejected).toBe(1);
    const totalByReviewer = r.byReviewer.reduce(
      (sum: number, v: { accepted: number; rejected: number }) => sum + v.accepted + v.rejected,
      0
    );
    expect(totalByReviewer).toBe(4);
  });

  it("measures turnaround from submission, not from when the draft was opened", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const from = new Date();
    const { token } = await provisionTierBCompany(adminToken);
    const { reportId } = await submitReport(token);

    // The employer sat on the draft for two days before submitting. Only the
    // time after submission is the review team's to answer for.
    await withContext({ userType: "platform" }, async (c) => {
      await c.query(
        `UPDATE conduct_reports
            SET created_at = now() - interval '48 hours',
                submitted_at = now() - interval '4 hours'
          WHERE id = $1`,
        [reportId]
      );
    });

    await request(app)
      .post(`/admin/reports/${reportId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "evidence_sufficient", notes: "Fine." })
      .expect(200);

    const res = await request(app)
      .get(statsUrl(from, new Date(Date.now() + 60_000)))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // ~4 hours, not ~48. Measured from created_at this would read as two days.
    expect(res.body.reports.turnaround.decided).toBe(1);
    expect(res.body.reports.turnaround.medianHours).toBeGreaterThan(3.5);
    expect(res.body.reports.turnaround.medianHours).toBeLessThan(5);
  });

  it("gives no accepted share when nothing was decided", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const from = new Date();
    const { token } = await provisionTierBCompany(adminToken);
    await submitReport(token);

    const res = await request(app)
      .get(statsUrl(from, new Date(Date.now() + 60_000)))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // Null, not 0. "Nothing decided yet" and "we accepted none of them" are
    // different statements and only one of them is a problem.
    expect(res.body.reports.decided).toBe(0);
    expect(res.body.reports.acceptanceRate).toBeNull();
    expect(res.body.reports.submitted).toBe(1);
  });

  it("counts cross-company access requests alongside the review figures", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const from = new Date();
    const owner = await provisionTierBCompany(adminToken);
    const other = await provisionTierBCompany(adminToken);

    const { reportId, nationalId } = await submitReport(owner.token);
    await request(app)
      .post(`/admin/reports/${reportId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "evidence_sufficient", notes: "Evidence holds up." })
      .expect(200);

    // Access is requested by NRC — the other company searches for the person,
    // it does not know a report id until access is granted.
    const req = await request(app)
      .post("/access-requests")
      .set("Authorization", `Bearer ${other.token}`)
      .send({ subject: { nationalId } });
    expect(req.status).toBe(201);
    // One request per published report the NRC matches, so the response is a
    // list rather than a single record.
    expect(req.body.items).toHaveLength(1);
    const requestId: string = req.body.items[0].accessRequestId;
    await request(app)
      .post(`/access-requests/${requestId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "approved" })
      .expect(200);

    const res = await request(app)
      .get(statsUrl(from, new Date(Date.now() + 60_000)))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.reports.access.requested).toBe(1);
    expect(res.body.reports.access.approved).toBe(1);
    expect(res.body.reports.access.denied).toBe(0);
  });
});
