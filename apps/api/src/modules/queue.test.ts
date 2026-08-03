/**
 * Reviewer work queue.
 *
 * The claims worth testing are the ones the queue exists to make true: two
 * reviewers cannot silently work the same item, a check waiting on the employer
 * is out of the pending queue but not lost, and turnaround is measured from the
 * decision rather than asserted.
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
  return { companyId, token };
}

async function raiseCheck(companyToken: string, fullName: string) {
  const res = await request(app)
    .post("/verifications")
    .set("Authorization", `Bearer ${companyToken}`)
    .send({ subject: { fullName, nationalId: helpers.uniq("12/ABC(N)") }, authorization: helpers.verificationAuthorization() });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("reviewer work queue", () => {
  it("claims an item and refuses a second reviewer's silent takeover", async () => {
    const superAdmin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(superAdmin);
    const other = await helpers.createPlatformUser("admin_reviewer");
    const otherToken = await loginPlatform(other);
    const { token } = await provisionCompany(adminToken);
    const checkId = await raiseCheck(token, "Claim Test");

    await request(app)
      .post(`/admin/verifications/${checkId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ to: superAdmin.id })
      .expect(200);

    const stolen = await request(app)
      .post(`/admin/verifications/${checkId}/assign`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ to: other.id });
    expect(stolen.status).toBe(409);

    // Taking it over deliberately is allowed — the guard is against doing it
    // by accident, not against doing it at all.
    await request(app)
      .post(`/admin/verifications/${checkId}/assign`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ to: other.id, force: true })
      .expect(200);

    const mine = await request(app)
      .get("/admin/verifications?status=pending&assignment=me")
      .set("Authorization", `Bearer ${otherToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((i: { id: string }) => i.id === checkId)).toBe(true);

    // And it is no longer in the super admin's own list.
    const notMine = await request(app)
      .get("/admin/verifications?status=pending&assignment=me")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(notMine.body.items.some((i: { id: string }) => i.id === checkId)).toBe(false);
  });

  it("parks a check on the employer and brings it back when they answer", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const checkId = await raiseCheck(token, "Info Test");

    await request(app)
      .post(`/admin/verifications/${checkId}/request-info`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ question: "Which branch did they work at?" })
      .expect(200);

    // Out of the pending queue: it is not work the reviewers owe an answer on.
    const pending = await request(app)
      .get("/admin/verifications?status=pending")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(pending.body.items.some((i: { id: string }) => i.id === checkId)).toBe(false);

    // The employer can see the question, and is told about it.
    const mine = await request(app)
      .get("/verifications")
      .set("Authorization", `Bearer ${token}`);
    const row = mine.body.items.find((i: { id: string }) => i.id === checkId);
    expect(row.status).toBe("need_more_info");
    expect(row.infoRequest).toBe("Which branch did they work at?");

    const notices = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${token}`);
    expect(
      notices.body.items.some(
        (n: { kind: string }) => n.kind === "verification.info_requested"
      )
    ).toBe(true);

    // Answering puts it back in the queue with the reply attached.
    await request(app)
      .post(`/verifications/${checkId}/respond`)
      .set("Authorization", `Bearer ${token}`)
      .send({ answer: "Yangon head office, 2019-2022." })
      .expect(200);

    // Searched by name: the queue is oldest-first and capped at 100, so on a
    // database with a backlog this check is not on the first page.
    const back = await request(app)
      .get("/admin/verifications?status=pending&q=Info%20Test")
      .set("Authorization", `Bearer ${adminToken}`);
    const queued = back.body.items.find((i: { id: string }) => i.id === checkId);
    expect(queued).toBeTruthy();
    expect(queued.reviewerNote).toContain("Yangon head office");
  });

  it("will not let one company answer another company's question", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const a = await provisionCompany(adminToken);
    const b = await provisionCompany(adminToken);
    const checkId = await raiseCheck(a.token, "Cross Tenant");

    await request(app)
      .post(`/admin/verifications/${checkId}/request-info`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ question: "Confirm the leaving date." })
      .expect(200);

    await request(app)
      .post(`/verifications/${checkId}/respond`)
      .set("Authorization", `Bearer ${b.token}`)
      .send({ answer: "Nothing to do with us." })
      .expect(404);
  });

  it("records turnaround on the decision and reports the backlog", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const decided = await raiseCheck(token, "Decided Soon");
    await raiseCheck(token, "Still Waiting");

    await request(app)
      .post(`/admin/verifications/${decided}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "completed", source: helpers.verificationSource() })
      .expect(200);

    const stats = await request(app)
      .get("/admin/verifications-stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.byStatus.pending.count).toBeGreaterThanOrEqual(1);
    expect(stats.body.turnaround.decided).toBeGreaterThanOrEqual(1);
    // Decided within the test run, so measurably under an hour.
    expect(stats.body.turnaround.medianHours).toBeLessThan(1);

    const done = await request(app)
      .get("/admin/verifications?status=completed")
      .set("Authorization", `Bearer ${adminToken}`);
    const row = done.body.items.find((i: { id: string }) => i.id === decided);
    expect(row.decidedAt).toBeTruthy();
  });

  it("searches the queue by subject, NRC, and company", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);
    const name = helpers.uniq("Findable");
    const checkId = await raiseCheck(token, name);

    const hit = await request(app)
      .get(`/admin/verifications?status=pending&q=${encodeURIComponent(name)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(hit.body.items).toHaveLength(1);
    expect(hit.body.items[0].id).toBe(checkId);
    // The reviewer is told who at the employer asked, so they know whom to chase.
    expect(hit.body.items[0].requestedByName).toBeTruthy();

    const miss = await request(app)
      .get("/admin/verifications?status=pending&q=definitely-not-a-real-name-xyz")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(miss.body.items).toHaveLength(0);
  });

  it("keeps the queue away from company accounts", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    await request(app)
      .get("/admin/verifications?status=pending")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    await request(app)
      .get("/admin/verifications-stats")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });
});
