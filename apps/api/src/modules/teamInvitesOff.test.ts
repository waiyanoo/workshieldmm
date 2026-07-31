/**
 * Team invitations, switched off.
 *
 * Invitations ship disabled — there is no email transport, so the flow rests on
 * an administrator forwarding a credential by hand, and that is a decision to
 * take deliberately per deployment rather than a default.
 *
 * Its own file because the flag is read when config/env is first imported, so a
 * test that wants it off cannot share a process with the ones that want it on.
 * Nothing is set here: the default IS off, which is the thing being asserted.
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

describe("team invitations disabled", () => {
  it("refuses to issue or accept an invitation, and says the team page has none", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const { token } = await provisionCompany(adminToken);

    const invite = await request(app)
      .post("/team/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: `${helpers.uniq("nope")}@example.com`, role: "company_user" });
    expect(invite.status).toBe(403);

    // Public endpoints are closed too, so a link issued while the flag was on
    // cannot be redeemed after it is switched off.
    await request(app).get("/team/invites/whatever-token-value-here").expect(403);
    await request(app)
      .post("/team/invites/accept")
      .send({ token: "whatever-token-value-here", fullName: "X", password: "L0ngEnoughPass!" })
      .expect(403);

    // The team page still works — it just does not offer invitations, and says
    // so, so the client can leave the controls out rather than disable them.
    const team = await request(app).get("/team").set("Authorization", `Bearer ${token}`);
    expect(team.status).toBe(200);
    expect(team.body.invitesEnabled).toBe(false);
    expect(team.body.members).toHaveLength(1);
  });
});
