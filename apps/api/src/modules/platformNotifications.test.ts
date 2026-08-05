/**
 * Notices addressed to platform staff. (0032)
 *
 * The events here are the ones no queue owns. A payment sitting unconfirmed is
 * money a customer has already sent; a company that has just finished uploading
 * its documents is one row inside a count of hundreds. Both used to depend on
 * somebody thinking to look.
 *
 * The claims worth pinning are about who can see what. These notices name
 * companies and amounts, and a company reading a notice written for reviewers
 * about itself would be a straightforward leak — so the separation is tested
 * from both directions, at the API and against the row itself.
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
let warnExpiringPromotions: typeof import("../jobs/lifecycle").warnExpiringPromotions;

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
  ({ closeQueues } = await import("../jobs/queues"));
  ({ warnExpiringPromotions } = await import("../jobs/lifecycle"));

  await helpers.ensurePaymentMethod(
    app,
    await loginPlatform(await helpers.createSuperAdmin()),
    "kbzpay"
  );
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

async function registerCompany() {
  const payload = helpers.companyRegistrationPayload();
  const reg = await request(app).post("/companies").send(payload).expect(201);
  return {
    companyId: reg.body.company.id as string,
    token: reg.body.accessToken as string,
    legalName: payload.company.legalName as string,
  };
}

async function uploadDoc(token: string, companyId: string, docType: string, filename: string) {
  await request(app)
    .post(`/companies/${companyId}/documents`)
    .set("Authorization", `Bearer ${token}`)
    .field("docType", docType)
    .attach("file", PDF, { filename, contentType: "application/pdf" })
    .expect(201);
}

async function verifyCompany(companyId: string, token: string, adminToken: string) {
  await helpers.approveCompanyDocuments(app, companyId, adminToken);
  await request(app)
    .post(`/companies/${companyId}/verify`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({})
    .expect(200);
  return token;
}

/** Every notice this reviewer can currently see, newest first. */
async function inbox(token: string) {
  const res = await request(app)
    .get("/notifications")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  return res.body as {
    unread: number;
    items: { id: string; kind: string; params: Record<string, unknown>; link: string | null }[];
  };
}

describe("platform notifications", () => {
  it("tells reviewers a company has finished uploading its documents", async () => {
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const { companyId, token, legalName } = await registerCompany();

    // One document is not a complete set, so there is nothing to announce yet.
    await uploadDoc(token, companyId, "dica_certificate", "dica.pdf");
    let seen = await inbox(reviewerToken);
    expect(seen.items.some((n) => n.params.company === legalName)).toBe(false);

    // The upload that completes the set is the one that raises the notice.
    await uploadDoc(token, companyId, "nrc", "nrc.pdf");
    seen = await inbox(reviewerToken);
    const notice = seen.items.find((n) => n.params.company === legalName);
    expect(notice).toBeTruthy();
    expect(notice!.kind).toBe("company.documents_ready");
    expect(notice!.link).toBe(`/admin/companies/${companyId}`);
  });

  it("tells reviewers a payment is waiting to be matched", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const { companyId, token, legalName } = await registerCompany();
    await uploadDoc(token, companyId, "dica_certificate", "dica.pdf");
    await uploadDoc(token, companyId, "nrc", "nrc.pdf");
    await verifyCompany(companyId, token, adminToken);

    const options = await request(app)
      .get("/payments/options")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const pkg = options.body.packages[0];
    const intent = await request(app)
      .post("/payments/intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ packageKey: pkg.key, provider: "kbzpay" })
      .expect(201);

    // Creating the intent is not the event — nothing has been paid yet.
    let seen = await inbox(reviewerToken);
    expect(
      seen.items.some(
        (n) => n.kind === "payment.awaiting_confirmation" && n.params.company === legalName
      )
    ).toBe(false);

    await request(app)
      .post(`/payments/intents/${intent.body.id}/proof`)
      .set("Authorization", `Bearer ${token}`)
      .field("payerReference", helpers.uniq("TXN"))
      .expect(200);

    seen = await inbox(reviewerToken);
    const notice = seen.items.find(
      (n) => n.kind === "payment.awaiting_confirmation" && n.params.company === legalName
    );
    expect(notice).toBeTruthy();
    expect(notice!.params.amount).toBe(intent.body.amountMmk);
    expect(notice!.link).toBe("/admin/payments");
  });

  it("keeps staff notices away from the company they are about", async () => {
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const { companyId, token, legalName } = await registerCompany();
    await uploadDoc(token, companyId, "dica_certificate", "dica.pdf");
    await uploadDoc(token, companyId, "nrc", "nrc.pdf");

    // The reviewer has it.
    const staff = await inbox(reviewerToken);
    expect(staff.items.some((n) => n.kind === "company.documents_ready")).toBe(true);

    // The company does not — not in its bell...
    const own = await inbox(token);
    expect(own.items.some((n) => n.kind === "company.documents_ready")).toBe(false);

    // ...and not in the database either, under its own RLS context. The API
    // filter and the row-level policy are two different controls and both have
    // to hold: a notice for reviewers naming a company is exactly the kind of
    // row a company must not be able to read about itself.
    const visible = await withContext(
      { userType: "company", companyId, userId: null },
      (c) =>
        c.query(`SELECT count(*)::int AS n FROM notifications WHERE audience <> 'company'`)
    );
    expect(visible.rows[0]!.n).toBe(0);
  });

  it("shows a Super Admin the reviewer notices as well as their own", async () => {
    const superToken = await loginPlatform(await helpers.createSuperAdmin());
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));

    // Only one promotion may cover a given date range, and the launch offer
    // from 0026 covers the next twelve months — so it stands down while this
    // test schedules one of its own, and is restored afterwards.
    const paused = await withContext({ userType: "platform" }, (c) =>
      c.query<{ id: string }>(
        `UPDATE pricing_promotions SET active = false WHERE active RETURNING id`
      )
    );
    const promo = await withContext({ userType: "platform" }, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO pricing_promotions (name, percent_off, starts_at, ends_at, active)
         VALUES ($1, 15, now() - interval '1 day', now() + interval '3 days', true)
         RETURNING id`,
        [helpers.uniq("Ending Offer")]
      )
    );
    const promoId = promo.rows[0]!.id;

    try {
      const warned = await warnExpiringPromotions();
      expect(warned).toContain(promoId);

      // Running the sweep again announces nothing further: it fires every
      // fifteen minutes and must not repeat itself.
      const again = await warnExpiringPromotions();
      expect(again).not.toContain(promoId);

      const forSuper = await inbox(superToken);
      expect(forSuper.items.some((n) => n.kind === "promotion.ending_soon")).toBe(true);

      // A reviewer has no business with pricing, and does not see it.
      const forReviewer = await inbox(reviewerToken);
      expect(forReviewer.items.some((n) => n.kind === "promotion.ending_soon")).toBe(false);
    } finally {
      await withContext({ userType: "platform" }, async (c) => {
        await c.query(`DELETE FROM notifications WHERE dedupe_key LIKE $1`, [
          `promo-ending:${promoId}:%`,
        ]);
        await c.query(`DELETE FROM pricing_promotions WHERE id = $1`, [promoId]);
        if (paused.rows.length) {
          await c.query(
            `UPDATE pricing_promotions SET active = true WHERE id = ANY($1::uuid[])`,
            [paused.rows.map((r) => r.id)]
          );
        }
      });
    }
  });

  it("marks a shared notice read for the whole audience", async () => {
    const reviewerToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const otherToken = await loginPlatform(await helpers.createPlatformUser("admin_reviewer"));
    const { companyId, token } = await registerCompany();
    await uploadDoc(token, companyId, "dica_certificate", "dica.pdf");
    await uploadDoc(token, companyId, "nrc", "nrc.pdf");

    const before = await inbox(reviewerToken);
    const notice = before.items.find((n) => n.kind === "company.documents_ready");
    expect(notice).toBeTruthy();

    await request(app)
      .post(`/notifications/${notice!.id}/read`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .expect(200);

    // Shared work, shared read state: once one reviewer has picked it up the
    // others do not need chasing.
    const forOther = await inbox(otherToken);
    const sameNotice = forOther.items.find((n) => n.id === notice!.id);
    expect(sameNotice).toBeTruthy();
    const stillUnread = await withContext({ userType: "platform" }, (c) =>
      c.query<{ read_at: string | null }>(`SELECT read_at FROM notifications WHERE id = $1`, [
        notice!.id,
      ])
    );
    expect(stillUnread.rows[0]!.read_at).toBeTruthy();
  });
});
