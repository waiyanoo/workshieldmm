/**
 * Receipts.
 *
 * The one that matters: a receipt exists only for money the platform confirmed
 * receiving. Everything else — the number, the expiry, the tenant scoping —
 * follows from that.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

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
  return { companyId, token, legalName: reg.body.company.legalName as string };
}

/** Buy a credit pack and take it as far as the reconciliation queue. */
async function submittedPurchase(companyToken: string) {
  const options = await request(app)
    .get("/payments/options")
    .set("Authorization", `Bearer ${companyToken}`)
    .expect(200);
  const pkg = options.body.packages[0];
  const provider = options.body.methods[0]?.provider ?? "kbzpay";

  const intent = await request(app)
    .post("/payments/intents")
    .set("Authorization", `Bearer ${companyToken}`)
    .send({ packageKey: pkg.key, provider })
    .expect(201);

  await request(app)
    .post(`/payments/intents/${intent.body.id}/proof`)
    .set("Authorization", `Bearer ${companyToken}`)
    .field("payerReference", helpers.uniq("TXN"))
    .expect(200);

  return { id: intent.body.id as string, credits: pkg.credits as number, amount: pkg.priceMmk as number };
}

describe("receipts", () => {
  it("issues a receipt only after the payment is confirmed", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token, legalName } = await provisionCompany(adminToken);
    const purchase = await submittedPurchase(token);

    // Submitted is not paid. No receipt, and nothing that looks like one.
    await request(app)
      .get(`/payments/${purchase.id}/receipt`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);

    const decision = await request(app)
      .post(`/admin/payments/${purchase.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "Matched KBZ statement line 12." })
      .expect(200);
    expect(decision.body.receiptNumber).toMatch(/^WS-R-\d{6}$/);

    const receipt = await request(app)
      .get(`/payments/${purchase.id}/receipt`)
      .set("Authorization", `Bearer ${token}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.receiptNumber).toBe(decision.body.receiptNumber);
    expect(receipt.body.paidBy.companyName).toBe(legalName);
    expect(receipt.body.totalMmk).toBe(purchase.amount);
    expect(receipt.body.lines[0].credits).toBe(purchase.credits);
    // The expiry is on the receipt, not only in the app — credits that lapse
    // are a term the customer is entitled to have in writing. (0018)
    expect(receipt.body.credits.expiresAt).toBeTruthy();
    expect(receipt.body.credits.purchased).toBe(purchase.credits);
  });

  it("gives a rejected payment no receipt", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const purchase = await submittedPurchase(token);

    await request(app)
      .post(`/admin/payments/${purchase.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "reject", note: "No matching transfer found." })
      .expect(200);

    await request(app)
      .get(`/payments/${purchase.id}/receipt`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("keeps one company's receipt out of another's hands", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const a = await provisionCompany(adminToken);
    const b = await provisionCompany(adminToken);
    const purchase = await submittedPurchase(a.token);

    await request(app)
      .post(`/admin/payments/${purchase.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "Confirmed." })
      .expect(200);

    await request(app)
      .get(`/payments/${purchase.id}/receipt`)
      .set("Authorization", `Bearer ${b.token}`)
      .expect(404);
  });

  it("puts the receipt number on the subscription receipt with its renewal date", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const plan = options.body.plans.find((p: { plan: string }) => p.plan === "starter");
    const provider = options.body.methods[0]?.provider ?? "kbzpay";

    const intent = await request(app)
      .post("/payments/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: plan.plan, billingCycle: "monthly", provider })
      .expect(201);
    await request(app)
      .post(`/payments/intents/${intent.body.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", helpers.uniq("TXN"))
      .expect(200);
    await request(app)
      .post(`/admin/payments/${intent.body.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "confirm", note: "Subscription payment received." })
      .expect(200);

    const receipt = await request(app)
      .get(`/payments/${intent.body.id}/receipt`)
      .set("Authorization", `Bearer ${token}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.receiptNumber).toMatch(/^WS-R-\d{6}$/);
    expect(receipt.body.subscription.plan).toBe("starter");
    // The renewal date is the thing customers open a receipt to check.
    expect(receipt.body.subscription.renewsAt).toBeTruthy();
    expect(receipt.body.credits).toBeNull();
  });
});
