/**
 * Super Admin control of promotional pricing.
 *
 * These endpoints set what every company is charged, so the claims worth
 * pinning are about authority and about money already taken:
 *
 *   - only a Super Admin can touch them;
 *   - a new promotion takes effect on the pricing screen immediately;
 *   - ending one restores list prices, and does not alter what was already paid;
 *   - two promotions cannot cover the same dates;
 *   - a promotion that has priced payments is never deleted.
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

/**
 * Clear the decks. These tests schedule their own promotions, and the launch
 * offer shipped in 0026 already occupies the next twelve months — the whole
 * point of the exclusion constraint. Restored afterwards.
 */
async function withNoPromotions<T>(fn: () => Promise<T>): Promise<T> {
  const paused = await withContext({ userType: "platform" }, (c) =>
    c.query<{ id: string }>(`UPDATE pricing_promotions SET active = false
                              WHERE active RETURNING id`)
  );
  try {
    return await fn();
  } finally {
    await withContext({ userType: "platform" }, async (c) => {
      // Stand down whatever the test scheduled first. Reactivating the real
      // offer while a test promotion still covers those dates would trip the
      // very exclusion constraint these tests exist to check.
      await c.query(`UPDATE pricing_promotions SET active = false WHERE active`);
      if (paused.rows.length) {
        await c.query(`UPDATE pricing_promotions SET active = true WHERE id = ANY($1::uuid[])`, [
          paused.rows.map((r) => r.id),
        ]);
      }
    });
  }
}

/**
 * Remove promotions this test created. One that priced a payment cannot be
 * deleted — payment_intents references it, which is the point — so those are
 * left behind, inactive and harmless.
 */
async function drop(ids: string[]) {
  if (!ids.length) return;
  await withContext({ userType: "platform" }, (c) =>
    c.query(
      `DELETE FROM pricing_promotions p
        WHERE p.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.promotion_id = p.id)`,
      [ids]
    )
  );
}

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe("promotion administration", () => {
  it("is closed to reviewers and to companies", async () => {
    const reviewer = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const superToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(superToken);

    for (const [label, bearer] of [
      ["reviewer", reviewer],
      ["company", token],
    ] as const) {
      const list = await request(app)
        .get("/admin/promotions")
        .set("Authorization", `Bearer ${bearer}`);
      expect(list.status, label).toBe(403);

      const create = await request(app)
        .post("/admin/promotions")
        .set("Authorization", `Bearer ${bearer}`)
        .send({ name: "Sneaky", percentOff: 50, startsAt: iso(DAY), endsAt: iso(2 * DAY) });
      expect(create.status, label).toBe(403);
    }
  });

  it("prices the shop from the promotion an admin schedules, and stops when it ends", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const created: string[] = [];

    await withNoPromotions(async () => {
      const before = await request(app)
        .get("/payments/options")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(before.body.promotion).toBeNull();
      const listPrice: number = before.body.packages[0].priceMmk;

      const promo = await request(app)
        .post("/admin/promotions")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Thingyan offer", percentOff: 25, startsAt: iso(-1000), endsAt: iso(30 * DAY) })
        .expect(201);
      created.push(promo.body.id);
      expect(promo.body.state).toBe("running");

      // The shop reflects it without anything being restarted.
      const during = await request(app)
        .get("/payments/options")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(during.body.promotion).toMatchObject({ name: "Thingyan offer", percentOff: 25 });
      expect(during.body.packages[0].priceMmk).toBeLessThan(listPrice);
      expect(during.body.packages[0].listPriceMmk).toBe(listPrice);

      // A buyer commits at the promotional price.
      const intent = await request(app)
        .post("/payments/intents")
        .set("Authorization", `Bearer ${token}`)
        .send({ packageKey: during.body.packages[0].key, provider: "mmqr" })
        .expect(201);
      const paid: number = intent.body.amountMmk;

      // Correcting the percentage moves the next quote.
      const patched = await request(app)
        .patch(`/admin/promotions/${promo.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ percentOff: 10 })
        .expect(200);
      expect(patched.body.percentOff).toBe(10);
      const after = await request(app)
        .get("/payments/options")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(after.body.packages[0].priceMmk).toBeGreaterThan(during.body.packages[0].priceMmk);

      // ...and leaves the intent already issued exactly where it was.
      const mine = await request(app)
        .get("/payments")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const row = mine.body.items.find((p: { id: string }) => p.id === intent.body.id);
      expect(row.amountMmk).toBe(paid);

      // Ending it puts list prices back.
      const ended = await request(app)
        .post(`/admin/promotions/${promo.body.id}/end`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(ended.body.state).toBe("ended");
      expect(ended.body.active).toBe(false);

      const restored = await request(app)
        .get("/payments/options")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(restored.body.promotion).toBeNull();
      expect(restored.body.packages[0].priceMmk).toBe(listPrice);

      // The record survives, and remembers what it priced.
      const list = await request(app)
        .get("/admin/promotions")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      const still = list.body.items.find((p: { id: string }) => p.id === promo.body.id);
      expect(still).toBeTruthy();
      expect(still.state).toBe("ended");
    });

    await drop(created);
  });

  it("refuses a second promotion over the same dates, and allows one after it", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const created: string[] = [];

    await withNoPromotions(async () => {
      const first = await request(app)
        .post("/admin/promotions")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "First", percentOff: 20, startsAt: iso(DAY), endsAt: iso(10 * DAY) })
        .expect(201);
      created.push(first.body.id);
      expect(first.body.state).toBe("scheduled");

      // Overlapping is refused: two answers to "what does this cost" is not a
      // state the shop can be in.
      const clash = await request(app)
        .post("/admin/promotions")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Clashing", percentOff: 40, startsAt: iso(5 * DAY), endsAt: iso(20 * DAY) });
      expect(clash.status).toBe(409);

      // Butting up against the end of the first is fine.
      const next = await request(app)
        .post("/admin/promotions")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Second", percentOff: 15, startsAt: iso(10 * DAY), endsAt: iso(20 * DAY) })
        .expect(201);
      created.push(next.body.id);

      // Cancelling one that never started frees its dates.
      await request(app)
        .post(`/admin/promotions/${first.body.id}/end`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      const reused = await request(app)
        .post("/admin/promotions")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Replacement", percentOff: 30, startsAt: iso(DAY), endsAt: iso(9 * DAY) })
        .expect(201);
      created.push(reused.body.id);
    });

    await drop(created);
  });

  it("rejects nonsense dates and implausible discounts", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());

    const backwards = await request(app)
      .post("/admin/promotions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Backwards", percentOff: 20, startsAt: iso(10 * DAY), endsAt: iso(DAY) });
    expect(backwards.status).toBe(400);

    // 90% off a subscription is a typo, not an offer.
    const absurd = await request(app)
      .post("/admin/promotions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Free money", percentOff: 90, startsAt: iso(DAY), endsAt: iso(2 * DAY) });
    expect(absurd.status).toBe(400);

    const zero = await request(app)
      .post("/admin/promotions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Nothing off", percentOff: 0, startsAt: iso(DAY), endsAt: iso(2 * DAY) });
    expect(zero.status).toBe(400);
  });
});
