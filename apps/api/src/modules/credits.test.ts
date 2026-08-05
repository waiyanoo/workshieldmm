/**
 * Credit metering. (Pricing Plan §3, §4)
 *
 * Covers the parts that cost money if they are wrong: the price of each metered
 * action, refusal when the balance is short, earning on acceptance, the
 * earliest-expiry-first burn order that makes rollover meaningful, and the
 * once-per-month guarantee on the bundled grant.
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
let credits: typeof import("./credits/credits.service");
let plans: typeof import("./credits/plans.service");
let closeQueues: typeof import("../jobs/queues").closeQueues;

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
  credits = await import("./credits/credits.service");
  plans = await import("./credits/plans.service");
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

const balanceOf = (companyId: string) =>
  withContext({ userType: "system" }, (c) => credits.getBalance(c, companyId));

describe("credits", () => {
  it("withholds welcome credits until the company is verified", async () => {
    // Registration alone earns nothing. A company that has only filled in a
    // form cannot run a check, so a balance would be an offer it cannot take
    // up — and it would start the one-month expiry clock (0018) running while
    // the account is still waiting on us.
    const reg = await request(app).post("/companies").send(helpers.companyRegistrationPayload());
    expect(reg.status).toBe(201);
    expect(await balanceOf(reg.body.company.id)).toBe(0);
  });

  it("gives welcome credits on verification and charges the listed price per search", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);

    expect(await balanceOf(companyId)).toBe(credits.WELCOME_CREDITS); // 10

    const summary = await request(app).get("/credits").set("Authorization", `Bearer ${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.balance).toBe(10);
    expect(summary.body.costs["verification.search"]).toBe(5);

    // 10 credits buys exactly two searches at 5 apiece.
    await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: { fullName: "A", nationalId: `CR-${Date.now()}-1` }, authorization: helpers.verificationAuthorization() })
      .expect(201);
    expect(await balanceOf(companyId)).toBe(5);

    await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: { fullName: "B", nationalId: `CR-${Date.now()}-2` }, authorization: helpers.verificationAuthorization() })
      .expect(201);
    expect(await balanceOf(companyId)).toBe(0);

    // The third is refused, and refusing must not create the check.
    const broke = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: { fullName: "C", nationalId: `CR-${Date.now()}-3` }, authorization: helpers.verificationAuthorization() });
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe("insufficient_credits");

    // Counted in the company's own context: `system` is neither platform nor a
    // company, and the RLS policy on verification_requests admits only those
    // two, so a system-context count would read 0 regardless of the truth.
    const rolledBack = await withContext({ userType: "company", companyId }, async (c) =>
      c.query(`SELECT count(*)::int AS n FROM verification_requests WHERE company_id = $1`, [
        companyId,
      ])
    );
    expect(rolledBack.rows[0].n).toBe(2); // not 3 — the refused search did not happen
    expect(await balanceOf(companyId)).toBe(0);
  });

  it("awards credits when a submitted report is accepted, and nothing when rejected", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);
    const start = await balanceOf(companyId);

    async function fileReport(nationalId: string) {
      const draft = await request(app)
        .post("/reports")
        .set("Authorization", `Bearer ${token}`)
        .send({
          subject: { fullName: "Subject", nationalId },
          categoryKey: "theft_fraud_misuse",
          narrativeSummary: "Confirmed theft, police report attached.",
        });
      expect(draft.status).toBe(201);
      await request(app)
        .post(`/reports/${draft.body.id}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", PDF, { filename: "e.pdf", contentType: "application/pdf" })
        .expect(201);
      await request(app)
        .post(`/reports/${draft.body.id}/submit`)
        .set("Authorization", `Bearer ${token}`)
        .send({ declaration: helpers.reportDeclaration() })
        .expect(200);
      return draft.body.id as string;
    }

    // Submitting is free — the balance must not move.
    const accepted = await fileReport(`EARN-${Date.now()}-a`);
    expect(await balanceOf(companyId)).toBe(start);

    await request(app)
      .post(`/admin/reports/${accepted}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "evidence_sufficient" })
      .expect(200);
    expect(await balanceOf(companyId)).toBe(start + credits.REPORT_ACCEPTED_REWARD);

    // A rejected report earns nothing — the incentive is accuracy, not volume.
    const afterAccept = await balanceOf(companyId);
    const rejected = await fileReport(`EARN-${Date.now()}-b`);
    await request(app)
      .post(`/admin/reports/${rejected}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "evidence_insufficient" })
      .expect(200);
    expect(await balanceOf(companyId)).toBe(afterAccept);
  });

  it("spends the earliest-expiring credits first so the monthly allowance goes before purchases", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId } = await provisionCompany(adminToken);

    // An older lot expiring imminently, and a fresh one. A 5-credit spend must
    // come out of the one about to lapse. The imminent lot is set an hour out so
    // it is unambiguously earlier than the welcome credits, which now expire at
    // month end and would otherwise be the earliest lot on a late-month run.
    await withContext({ userType: "system" }, async (c) => {
      await c.query(
        `INSERT INTO credit_lots (company_id, amount, remaining, reason, granted_at, expires_at)
         VALUES ($1, 20, 20, 'purchase', now() - interval '80 days', now() + interval '1 hour')`,
        [companyId]
      );
      await c.query(
        `INSERT INTO credit_lots (company_id, amount, remaining, reason, expires_at)
         VALUES ($1, 20, 20, 'purchase', now() + interval '90 days')`,
        [companyId]
      );
      await credits.spendCredits(c, { companyId, action: "verification.search" }); // 5
    });

    const lots = await withContext({ userType: "system" }, async (c) =>
      c.query<{ remaining: number }>(
        `SELECT remaining FROM credit_lots
          WHERE company_id = $1 AND reason = 'purchase' ORDER BY expires_at`,
        [companyId]
      )
    );
    expect(lots.rows[0]!.remaining).toBe(15); // soonest-expiring lot was drawn down
    expect(lots.rows[1]!.remaining).toBe(20); // the fresh one untouched
  });

  it("grants bundled credits once per month, rolling over for 3 months", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId } = await provisionCompany(adminToken);

    await request(app)
      .post(`/admin/companies/${companyId}/plan`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ plan: "starter", reason: "pilot cohort" })
      .expect(200);

    // Since 0015 the grant follows a PAID PERIOD, not the plan column, so an
    // admin setting a plan by hand grants nothing on its own. That is the
    // point — it is what stops unpaid plans minting credits every month.
    await plans.grantMonthlyCredits();
    expect(await balanceOf(companyId)).toBe(credits.WELCOME_CREDITS);

    await withContext({ userType: "system" }, (c) =>
      c.query(
        `INSERT INTO company_plan_periods (company_id, plan, billing_cycle, ends_at)
         VALUES ($1, 'starter', 'monthly', now() + interval '1 month')`,
        [companyId]
      )
    );

    const before = await balanceOf(companyId);
    await plans.grantMonthlyCredits();
    expect(await balanceOf(companyId)).toBe(before + credits.PLAN_MONTHLY_CREDITS.starter!);

    // A second sweep in the same month must not mint a second grant.
    const afterFirst = await balanceOf(companyId);
    await plans.grantMonthlyCredits();
    expect(await balanceOf(companyId)).toBe(afterFirst);

    // Every lot carries the lifetime its source earns: welcome 1 month, the
    // plan allowance 3, purchases 6. (0018)
    await withContext({ userType: "system" }, (c) =>
      c.query(
        `INSERT INTO credit_lots (company_id, amount, remaining, reason, expires_at)
         VALUES ($1, 5, 5, 'purchase', now() + make_interval(months => $2))`,
        [companyId, credits.CREDIT_LIFETIME_MONTHS.purchase]
      )
    );
    const lifetimes = await withContext({ userType: "system" }, async (c) =>
      (
        await c.query<{ reason: string; months: string }>(
          `SELECT reason,
                  round(extract(epoch from (expires_at - granted_at)) / 2629746)::text AS months
             FROM credit_lots WHERE company_id = $1`,
          [companyId]
        )
      ).rows
    );
    const byReason = Object.fromEntries(lifetimes.map((l) => [l.reason, Number(l.months)]));
    expect(byReason.welcome).toBe(1);
    expect(byReason.monthly_grant).toBe(3);
    expect(byReason.purchase).toBe(6);

    // Once a lot's lifetime is up it lapses, recorded rather than silently lost.
    await withContext({ userType: "system" }, (c) =>
      c.query(`UPDATE credit_lots SET expires_at = now() - interval '1 day' WHERE company_id = $1`, [
        companyId,
      ])
    );
    expect(await plans.expireCredits()).toBeGreaterThan(0);
    expect(await balanceOf(companyId)).toBe(0);

    const ledger = await withContext({ userType: "system" }, async (c) =>
      c.query(
        `SELECT 1 FROM credit_ledger WHERE company_id = $1 AND action = 'expire.rollover'`,
        [companyId]
      )
    );
    expect(ledger.rowCount).toBeGreaterThan(0);
  });
});
