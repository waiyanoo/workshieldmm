/**
 * Document review checklist + notifications.
 *
 * The test that matters most is the negative one: before this feature,
 * verification only checked that a file EXISTED, so an unopened upload passed.
 * Verification must now refuse until each required document has been approved.
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

/** Register + upload both required documents, but review none of them. */
async function companyWithUnreviewedDocs() {
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
  return { companyId, token };
}

const docsOf = async (companyId: string, token: string) =>
  (await request(app).get(`/companies/${companyId}/documents`).set("Authorization", `Bearer ${token}`))
    .body.items as { id: string; docType: string; reviewStatus: string; reviewReason: string | null }[];

describe("document review", () => {
  it("refuses to verify a company whose documents nobody has approved", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await companyWithUnreviewedDocs();

    // Uploaded but unreviewed — the old rule would have passed here.
    const docs = await docsOf(companyId, token);
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.reviewStatus === "pending")).toBe(true);

    const tooEarly = await request(app)
      .post(`/companies/${companyId}/verify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.error.message).toMatch(/not approved yet/i);

    // Approve one only — still short of the requirement.
    const dica = docs.find((d) => d.docType === "dica_certificate")!;
    await request(app)
      .post(`/companies/${companyId}/documents/${dica.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" })
      .expect(200);

    const stillShort = await request(app)
      .post(`/companies/${companyId}/verify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(stillShort.status).toBe(400);
    expect(stillShort.body.error.message).toMatch(/nrc/i);

    // Approve the NRC too — now it verifies.
    const nrc = docs.find((d) => d.docType === "nrc")!;
    await request(app)
      .post(`/companies/${companyId}/documents/${nrc.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" })
      .expect(200);

    const verified = await request(app)
      .post(`/companies/${companyId}/verify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe("verified");
  });

  it("requires a reason to reject, and shows it to the company", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await companyWithUnreviewedDocs();
    const docs = await docsOf(companyId, token);
    const dica = docs.find((d) => d.docType === "dica_certificate")!;

    // A rejection with no reason leaves the company nothing to act on.
    const noReason = await request(app)
      .post(`/companies/${companyId}/documents/${dica.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "rejected" });
    expect(noReason.status).toBe(400);

    await request(app)
      .post(`/companies/${companyId}/documents/${dica.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "rejected", reason: "The scan is cut off — page 2 is missing." })
      .expect(200);

    const after = await docsOf(companyId, token);
    const rejected = after.find((d) => d.id === dica.id)!;
    expect(rejected.reviewStatus).toBe("rejected");
    expect(rejected.reviewReason).toMatch(/page 2 is missing/);

    // …and the company is told, in a form their own language can render.
    const notes = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    expect(notes.status).toBe(200);
    const note = notes.body.items.find((n: { kind: string }) => n.kind === "document.rejected");
    expect(note).toBeTruthy();
    expect(note.params.docType).toBe("dica_certificate");
    expect(note.severity).toBe("warning");
    expect(notes.body.unread).toBeGreaterThan(0);
  });

  it("lets a reviewer change their mind on a document", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await companyWithUnreviewedDocs();
    const docs = await docsOf(companyId, token);
    const nrc = docs.find((d) => d.docType === "nrc")!;

    await request(app)
      .post(`/companies/${companyId}/documents/${nrc.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "rejected", reason: "Wrong person" })
      .expect(200);
    await request(app)
      .post(`/companies/${companyId}/documents/${nrc.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" })
      .expect(200);

    const after = await docsOf(companyId, token);
    const fixed = after.find((d) => d.id === nrc.id)!;
    expect(fixed.reviewStatus).toBe("approved");
    // The stale rejection reason must not linger next to an approval.
    expect(fixed.reviewReason).toBeNull();
  });

  it("marks notifications read", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { companyId, token } = await companyWithUnreviewedDocs();
    const docs = await docsOf(companyId, token);

    await request(app)
      .post(`/companies/${companyId}/documents/${docs[0]!.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" })
      .expect(200);

    const before = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    expect(before.body.unread).toBeGreaterThan(0);

    await request(app)
      .post("/notifications/read-all")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const after = await request(app).get("/notifications").set("Authorization", `Bearer ${token}`);
    expect(after.body.unread).toBe(0);
    expect(after.body.items.length).toBeGreaterThan(0); // read, not deleted
  });
});
