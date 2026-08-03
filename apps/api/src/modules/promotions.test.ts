/**
 * Launch promotion.
 *
 * The claims that matter are about money, so they are worth being exact about:
 *
 *   - the price quoted on the pricing screen is the price actually charged;
 *   - the discount is frozen on the intent, so a promotion ending mid-payment
 *     does not reprice a quote somebody is already paying;
 *   - credit COSTS are not discounted — only kyat prices are;
 *   - when no promotion is running, nothing changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { applyPromotion } from "./payments/promotions";

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

/** Run `fn` with no promotion in force, then restore whatever was active. */
async function withoutPromotion<T>(fn: () => Promise<T>): Promise<T> {
  const paused = await withContext({ userType: "platform" }, (c) =>
    c.query<{ id: string }>(
      `UPDATE pricing_promotions SET active = false
        WHERE active AND now() >= starts_at AND now() < ends_at
        RETURNING id`
    )
  );
  try {
    return await fn();
  } finally {
    if (paused.rows.length) {
      await withContext({ userType: "platform" }, (c) =>
        c.query(`UPDATE pricing_promotions SET active = true WHERE id = ANY($1::uuid[])`, [
          paused.rows.map((r) => r.id),
        ])
      );
    }
  }
}

describe("launch promotion", () => {
  it("rounds down to the nearest 50 MMK and never charges above the discount", () => {
    const promo = { id: "x", name: "Launch offer", percentOff: 30, startsAt: "", endsAt: "" };
    // 49,900 × 0.7 = 34,930 → floored to 34,900.
    expect(applyPromotion(49_900, promo).amountMmk).toBe(34_900);
    // 24,950 × 0.7 = 17,465 → 17,450.
    expect(applyPromotion(24_950, promo).amountMmk).toBe(17_450);
    expect(applyPromotion(149_000, promo).amountMmk).toBe(104_300);
    expect(applyPromotion(1_490_000, promo).amountMmk).toBe(1_043_000);

    // Rounding only ever moves in the customer's favour.
    for (const list of [49_900, 24_950, 149_000, 134_700, 399_200, 499_000]) {
      const out = applyPromotion(list, promo);
      expect(out.amountMmk).toBeLessThanOrEqual(Math.round(list * 0.7));
      expect(out.listAmountMmk).toBe(list);
      expect(out.discountPercent).toBe(30);
    }

    // No promotion, no change.
    expect(applyPromotion(49_900, null)).toEqual({
      amountMmk: 49_900,
      listAmountMmk: 49_900,
      discountPercent: 0,
      promotionId: null,
    });
  });

  it("charges exactly what the pricing screen quoted", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(options.body.promotion).toMatchObject({ percentOff: 30 });
    const pkg = options.body.packages[0];
    // The quote carries both, so the screen can strike through the old price.
    expect(pkg.listPriceMmk).toBeGreaterThan(pkg.priceMmk);
    expect(pkg.priceMmk).toBe(applyPromotion(pkg.listPriceMmk, {
      id: "", name: "", percentOff: 30, startsAt: "", endsAt: "",
    }).amountMmk);

    const intent = await request(app)
      .post("/payments/intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ packageKey: pkg.key, provider: options.body.methods[0]?.provider ?? "mmqr" })
      .expect(201);

    // What the buyer is asked to transfer is what the page showed them.
    expect(intent.body.amountMmk).toBe(pkg.priceMmk);
    expect(intent.body.listAmountMmk).toBe(pkg.listPriceMmk);
    expect(intent.body.discountPercent).toBe(30);

    // Subscriptions the same.
    const plan = options.body.plans.find((p: { plan: string }) => p.plan === "starter");
    expect(plan.monthlyListMmk).toBeGreaterThan(plan.monthlyMmk);
    const sub = await request(app)
      .post("/payments/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "starter", billingCycle: "monthly", provider: options.body.methods[0]?.provider ?? "mmqr" })
      .expect(201);
    expect(sub.body.amountMmk).toBe(plan.monthlyMmk);
  });

  it("holds the quoted price even if the promotion ends mid-payment", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const pkg = options.body.packages[0];
    const intent = await request(app)
      .post("/payments/intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ packageKey: pkg.key, provider: options.body.methods[0]?.provider ?? "mmqr" })
      .expect(201);
    const discounted: number = intent.body.amountMmk;

    // The offer ends while the buyer is at the bank.
    await withoutPromotion(async () => {
      await request(app)
        .post(`/payments/intents/${intent.body.id}/proof`)
        .set("Authorization", `Bearer ${token}`)
        .field("payerReference", helpers.uniq("TXN"))
        .expect(200);

      const confirmed = await request(app)
        .post(`/admin/payments/${intent.body.id}/decision`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ decision: "confirm", note: "Matched statement." })
        .expect(200);
      expect(confirmed.body.credits).toBe(pkg.credits);
    });

    const receipt = await request(app)
      .get(`/payments/${intent.body.id}/receipt`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // Charged the promotional price, and the receipt still explains why.
    expect(receipt.body.totalMmk).toBe(discounted);
    expect(receipt.body.discount).toMatchObject({
      percentOff: 30,
      listMmk: pkg.listPriceMmk,
      savedMmk: pkg.listPriceMmk - discounted,
    });

    // And the document adds up: items at list price, less the discount, equals
    // the total. Showing the charged price on the item line as well would
    // subtract the discount twice.
    const lineTotal = receipt.body.lines.reduce(
      (sum: number, l: { amountMmk: number }) => sum + l.amountMmk,
      0
    );
    expect(lineTotal).toBe(pkg.listPriceMmk);
    expect(lineTotal - receipt.body.discount.savedMmk).toBe(receipt.body.totalMmk);
  });

  it("discounts kyat but never credits", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const pkg = options.body.packages.find((p: { key: string }) => p.key === "starter_50");
    // Cheaper in money, identical in credits — discounting both would compound
    // into a far bigger giveaway than "30% off" describes.
    expect(pkg.priceMmk).toBeLessThan(pkg.listPriceMmk);
    expect(pkg.credits).toBe(50);

    const credits = await request(app)
      .get("/credits")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(credits.body.costs["verification.search"]).toBe(5);
  });

  it("charges list price when no promotion is running", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    await withoutPromotion(async () => {
      const options = await request(app)
        .get("/payments/options")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(options.body.promotion).toBeNull();

      const pkg = options.body.packages[0];
      expect(pkg.priceMmk).toBe(pkg.listPriceMmk);

      const intent = await request(app)
        .post("/payments/intents")
        .set("Authorization", `Bearer ${token}`)
        .send({ packageKey: pkg.key, provider: options.body.methods[0]?.provider ?? "mmqr" })
        .expect(201);
      expect(intent.body.amountMmk).toBe(pkg.listPriceMmk);
      expect(intent.body.discountPercent).toBe(0);
    });
  });
});
