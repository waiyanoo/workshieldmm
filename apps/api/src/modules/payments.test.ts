/**
 * QR credit purchase with manual reconciliation. (Pricing Plan §3, §7)
 *
 * The tests that matter here are the ones protecting money: a screenshot alone
 * must not create credits, the same wallet transaction cannot be claimed twice,
 * and confirming must be idempotent against a double-click.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

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

  // A payment method must exist before anyone can pay. Seeded through the real
  // admin endpoint rather than a direct insert: the RLS write policy admits
  // platform staff only, which is the behaviour we want to rely on.
  const setupToken = await loginPlatform(await helpers.createSuperAdmin());
  await request(app)
    .post("/admin/payment-methods")
    .set("Authorization", `Bearer ${setupToken}`)
    .field("provider", "kbzpay")
    .field("displayName", "KBZPay")
    .field("accountName", "Dragon Innovation")
    .field("accountNumber", "09-000000000")
    .field("active", "true")
    .expect(200);
});

afterAll(async () => {
  await Promise.allSettled([closeQueues(), pool.end(), redis.quit()]);
});

const PDF = Buffer.from("%PDF-1.4 doc");
const PNG = Buffer.from("\x89PNG\r\n\x1a\n fake screenshot");

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

async function startIntent(token: string, packageKey = "standard_100") {
  const res = await request(app)
    .post("/payments/intents")
    .set("Authorization", `Bearer ${token}`)
    .send({ packageKey, provider: "kbzpay" });
  expect(res.status).toBe(201);
  return res.body as { id: string; referenceCode: string; credits: number; amountMmk: number };
}

describe("credit purchase", () => {
  it("does not grant credits until an admin confirms the payment", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);
    const before = await balanceOf(companyId);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`);
    expect(options.status).toBe(200);
    expect(options.body.packages.length).toBeGreaterThan(0);

    const intent = await startIntent(token);
    expect(intent.referenceCode).toMatch(/^WS-[A-Z0-9]{6}$/);
    expect(intent.credits).toBe(100);
    expect(await balanceOf(companyId)).toBe(before); // creating an intent buys nothing

    // Declaring payment — with a screenshot — still must not create credits.
    await request(app)
      .post(`/payments/intents/${intent.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", `TXN-${Date.now()}`)
      .attach("proof", PNG, { filename: "receipt.png", contentType: "image/png" })
      .expect(200);
    expect(await balanceOf(companyId)).toBe(before);

    // It lands on the reconciliation queue instead.
    const queue = await request(app)
      .get("/admin/payments?status=submitted")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(queue.body.items.some((p: { id: string }) => p.id === intent.id)).toBe(true);

    // Only the admin's confirm grants them.
    const confirmed = await request(app)
      .post(`/admin/payments/${intent.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "Matched KBZPay statement" });
    expect(confirmed.status).toBe(200);
    expect(await balanceOf(companyId)).toBe(before + 100);

    // Re-deciding is refused, so a double-click cannot grant twice.
    const again = await request(app)
      .post(`/admin/payments/${intent.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "again" });
    expect(again.status).toBe(409);
    expect(await balanceOf(companyId)).toBe(before + 100);
  });

  it("refuses to let the same wallet transaction be claimed twice", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const txn = `DUP-${Date.now()}`;

    const first = await startIntent(token);
    await request(app)
      .post(`/payments/intents/${first.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", txn)
      .expect(200);

    // A second purchase quoting the same transaction number is rejected.
    const second = await startIntent(token);
    const reused = await request(app)
      .post(`/payments/intents/${second.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", txn);
    expect(reused.status).toBe(409);
    expect(reused.body.error.message).toMatch(/already been submitted/i);
  });

  it("rejects a payment that cannot be found, granting nothing", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);
    const before = await balanceOf(companyId);

    const intent = await startIntent(token, "starter_50");
    await request(app)
      .post(`/payments/intents/${intent.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", `BOGUS-${Date.now()}`)
      .expect(200);

    const rejected = await request(app)
      .post(`/admin/payments/${intent.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "reject", note: "No matching line on the statement" });
    expect(rejected.status).toBe(200);
    expect(await balanceOf(companyId)).toBe(before);

    // The buyer can see why.
    const mine = await request(app).get("/payments").set("Authorization", `Bearer ${token}`);
    const row = mine.body.items.find((p: { id: string }) => p.id === intent.id);
    expect(row.status).toBe("rejected");
    expect(row.decisionNote).toMatch(/No matching line/);
  });

  it("activates a paid plan on confirmation, and stops granting once it lapses", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);

    // Buying a plan is the same QR flow, quoting the monthly fee. Read the fee
    // from the pricing screen rather than hard-coding it, so a promotion (0026)
    // reprices this test the same way it reprices the buyer.
    const pricing = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const starter = pricing.body.plans.find((p: { plan: string }) => p.plan === "starter");

    const intent = await request(app)
      .post("/payments/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "starter", billingCycle: "monthly", provider: "kbzpay" });
    expect(intent.status).toBe(201);
    expect(intent.body.amountMmk).toBe(starter.monthlyMmk);
    expect(intent.body.kind).toBe("subscription");

    await request(app)
      .post(`/payments/intents/${intent.body.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", `SUB-${Date.now()}`)
      .expect(200);

    // Unpaid so far: no plan, and the sweep must not grant bundled credits.
    const beforeConfirm = await balanceOf(companyId);
    await plans.grantMonthlyCredits();
    expect(await balanceOf(companyId)).toBe(beforeConfirm);

    // Confirming activates the plan and grants the first month up front.
    const confirmed = await request(app)
      .post(`/admin/payments/${intent.body.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "Matched statement" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.plan).toBe("starter");
    expect(await balanceOf(companyId)).toBe(beforeConfirm + 100);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`);
    expect(options.body.currentPlan.plan).toBe("starter");

    // Wind the period into the past: the plan lapses to free and no further
    // bundled credits are granted.
    // Move the whole period into the past — starts_at as well, or the row would
    // violate the ends_at > starts_at constraint.
    await withContext({ userType: "system" }, (c) =>
      c.query(
        `UPDATE company_plan_periods
            SET starts_at = now() - interval '32 days', ends_at = now() - interval '1 day'
          WHERE company_id = $1`,
        [companyId]
      )
    );
    expect(await plans.lapseExpiredPlans()).toBeGreaterThan(0);

    const afterLapse = await balanceOf(companyId);
    await plans.grantMonthlyCredits();
    expect(await balanceOf(companyId)).toBe(afterLapse); // nothing granted while unpaid

    const plan = await withContext({ userType: "system" }, async (c) =>
      (await c.query(`SELECT plan FROM companies WHERE id = $1`, [companyId])).rows[0]
    );
    expect(plan.plan).toBe("free");
    // Credits already paid for are NOT confiscated by the downgrade.
    expect(afterLapse).toBeGreaterThan(0);
  });

  it("extends an existing plan period instead of restarting it on renewal", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);

    async function buyPlan() {
      const i = await request(app)
        .post("/payments/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({ plan: "starter", billingCycle: "monthly", provider: "kbzpay" });
      await request(app)
        .post(`/payments/intents/${i.body.id}/proof`)
        .set("Authorization", `Bearer ${token}`)
        .field("payerReference", `REN-${Date.now()}-${Math.random()}`)
        .expect(200);
      const done = await request(app)
        .post(`/admin/payments/${i.body.id}/decision`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ decision: "confirm", note: "matched" });
      expect(done.status).toBe(200);
      return new Date(done.body.periodEndsAt).getTime();
    }

    const firstEnd = await buyPlan();
    const secondEnd = await buyPlan();

    // Renewing early stacks on top rather than throwing away paid-for days.
    const monthMs = 27 * 24 * 3600 * 1000;
    expect(secondEnd - firstEnd).toBeGreaterThan(monthMs);
  });

  it("freezes the quoted price even if the catalogue changes afterwards", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await provisionCompany(adminToken);
    const before = await balanceOf(companyId);

    const intent = await startIntent(token);
    expect(intent.credits).toBe(100);

    // Catalogue repriced mid-payment.
    await withContext({ userType: "system" }, (c) =>
      c.query(`UPDATE credit_packages SET credits = 20 WHERE key = 'standard_100'`)
    );
    try {
      await request(app)
        .post(`/payments/intents/${intent.id}/proof`)
        .set("Authorization", `Bearer ${token}`)
        .field("payerReference", `FREEZE-${Date.now()}`)
        .expect(200);
      await request(app)
        .post(`/admin/payments/${intent.id}/decision`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ decision: "confirm", note: "matched" })
        .expect(200);

      // They get the 100 they were quoted, not the new 20.
      expect(await balanceOf(companyId)).toBe(before + 100);
    } finally {
      await withContext({ userType: "system" }, (c) =>
        c.query(`UPDATE credit_packages SET credits = 100 WHERE key = 'standard_100'`)
      );
    }
  });
});
