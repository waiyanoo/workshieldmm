/**
 * Platform statistics.
 *
 * Two things here are easy to get wrong and expensive to get wrong quietly:
 *
 *   - The period must EXCLUDE what falls outside it. A dashboard that silently
 *     counts everything looks plausible and is useless.
 *   - "Credits used" must mean credits somebody spent. Credits that lapsed or
 *     were clawed back also leave the balance, and folding them in inflates the
 *     headline with usage that never happened.
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
  return { companyId, token };
}

function statsUrl(from: Date, to: Date, tz = 390) {
  const q = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    tzOffsetMinutes: String(tz),
  });
  return `/admin/stats?${q}`;
}

describe("platform statistics", () => {
  it("counts onboarding, spend and revenue inside the period and nothing outside it", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());

    // A window that starts now: everything below happens inside it, and
    // everything the database already held happened before it.
    const from = new Date();
    const { companyId, token } = await provisionCompany(adminToken);

    // One search: 5 credits out of the 10 welcome credits.
    await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: { fullName: "Stat Subject", nationalId: helpers.uniq("12/STAT(N)") } })
      .expect(201);

    // A purchase, taken all the way to confirmed so it counts as revenue.
    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const pkg = options.body.packages[0];
    const intent = await request(app)
      .post("/payments/intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ packageKey: pkg.key, provider: options.body.methods[0]?.provider ?? "kbzpay" })
      .expect(201);
    await request(app)
      .post(`/payments/intents/${intent.body.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", helpers.uniq("TXN"))
      .expect(200);
    await request(app)
      .post(`/admin/payments/${intent.body.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "Matched statement." })
      .expect(200);

    const to = new Date(Date.now() + 60_000);
    const res = await request(app)
      .get(statsUrl(from, to))
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const s = res.body;
    expect(s.onboarding.registered).toBe(1);
    expect(s.onboarding.verified).toBe(1);
    expect(s.onboarding.firstCheck).toBe(1);
    // The welcome grant lands on verification, and the purchase on confirmation.
    expect(s.credits.used).toBe(5);
    expect(s.credits.usedBy).toEqual([
      { action: "verification.search", credits: 5, events: 1 },
    ]);
    expect(s.credits.spendingCompanies).toBe(1);
    expect(s.purchases.creditsSold).toBe(pkg.credits);
    expect(s.purchases.totalMmk).toBe(pkg.priceMmk);
    expect(s.purchases.creditPackPayments).toBe(1);

    // Standing totals are all-time by design, so they see the rest of the table.
    expect(s.onboarding.totals.all).toBeGreaterThanOrEqual(1);

    // A window that closed before any of this must show none of it. Dated well
    // in the past rather than "the two minutes before this test": the suite runs
    // serially in one database, so the minutes either side of any test belong to
    // its neighbours and would legitimately contain their companies.
    const earlier = await request(app)
      .get(statsUrl(new Date("2020-01-01T00:00:00Z"), new Date("2020-02-01T00:00:00Z")))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(earlier.body.onboarding.registered).toBe(0);
    expect(earlier.body.credits.used).toBe(0);
    expect(earlier.body.purchases.totalMmk).toBe(0);

    void companyId;
  });

  it("does not count expired or reversed credits as usage", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const from = new Date();
    const { companyId } = await provisionCompany(adminToken);

    // Credits leave a balance three ways. Only one of them is somebody using
    // the product; the dashboard has to tell them apart.
    await withContext({ userType: "system" }, async (c) => {
      await c.query(
        `INSERT INTO credit_ledger (company_id, delta, action)
         VALUES ($1, -40, 'expire.rollover'), ($1, -10, 'reverse.report_withdrawn')`,
        [companyId]
      );
    });

    const res = await request(app)
      .get(statsUrl(from, new Date(Date.now() + 60_000)))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.credits.used).toBe(0);
    expect(res.body.credits.usedBy).toEqual([]);
    expect(res.body.credits.expired).toBe(40);
    expect(res.body.credits.reversed).toBe(10);
    // A company that only had credits expire is not a company that spent any.
    expect(res.body.credits.spendingCompanies).toBe(0);
  });

  it("buckets the series in the caller's timezone, not the server's", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());

    // 20:00 UTC on a fixed day. In Yangon (+6:30) that is 02:30 the NEXT day,
    // so the two offsets must place it in different buckets — the exact error
    // a UTC-only implementation makes for every Myanmar evening.
    const at = new Date("2026-03-10T20:00:00.000Z");
    const from = new Date("2026-03-09T00:00:00.000Z");
    const to = new Date("2026-03-13T00:00:00.000Z");

    await withContext({ userType: "platform" }, async (c) => {
      await c.query(
        `INSERT INTO companies (legal_name, registration_number, status, created_at)
         VALUES ($1, $2, 'pending', $3)`,
        [`TZ Co ${helpers.uniq("x")}`, helpers.uniq("DICA-TZ"), at]
      );
    });

    const utc = await request(app)
      .get(statsUrl(from, to, 0))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const yangon = await request(app)
      .get(statsUrl(from, to, 390))
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const bucketWith = (body: { series: { bucket: string; registered: number }[] }) =>
      body.series.find((s) => s.registered > 0)?.bucket;

    expect(bucketWith(utc.body)).toBe("2026-03-10");
    expect(bucketWith(yangon.body)).toBe("2026-03-11");
    // Same period either way — only the bucketing moves.
    expect(utc.body.onboarding.registered).toBe(yangon.body.onboarding.registered);
  });

  it("is refused to reviewers and companies", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const window = statsUrl(new Date(Date.now() - 86_400_000), new Date());

    await request(app).get(window).set("Authorization", `Bearer ${token}`).expect(403);
    await request(app).get(window).set("Authorization", `Bearer ${reviewerToken}`).expect(403);
  });

  it("rejects a period that ends before it starts", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const now = new Date();
    const res = await request(app)
      .get(statsUrl(now, new Date(now.getTime() - 1000)))
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
