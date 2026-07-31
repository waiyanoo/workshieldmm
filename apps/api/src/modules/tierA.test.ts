/**
 * Tier A end-to-end integration test.
 *
 * Exercises the full flow and, critically, the compliance controls: the
 * verified-employer gate, MFA on privileged login, transactional audit writes,
 * and RLS cross-company isolation. Runs against the real dev Postgres.
 */
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";

// Pin the flag off before anything imports config/env, which freezes the
// environment on first read. Otherwise a developer who enables Tier B in their
// local .env fails the readiness assertion below — the test would be asserting
// their config rather than the behaviour it means to pin.
process.env.FEATURE_TIER_B_ENABLED = "false";

const { createApp } = await import("../app");
const { pool } = await import("../db/pool");
const { redis } = await import("../lib/redis");
const { companyRegistrationPayload, createSuperAdmin, approveCompanyDocuments } = await import(
  "../test/helpers"
);

const app = createApp();

afterAll(async () => {
  await Promise.allSettled([pool.end(), redis.quit()]);
});

describe("Tier A vertical slice", () => {
  it("reports readiness with Tier B disabled", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.tierB).toBe(false);
  });

  it("runs the full register → verify → check flow with the right gates", async () => {
    // 1. Public employer registration → pending, returns a session.
    const payload = companyRegistrationPayload();
    const reg = await request(app).post("/companies").send(payload);
    expect(reg.status).toBe(201);
    expect(reg.body.company.status).toBe("pending");
    const companyId: string = reg.body.company.id;
    const companyToken: string = reg.body.accessToken;

    // 2. Verification is blocked while the company is unverified.
    const blocked = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${companyToken}`)
      .send({ subject: { fullName: "Jane Doe", nationalId: "12/ABC(N)123456" } });
    expect(blocked.status).toBe(403);

    // 3. Super Admin login requires MFA.
    const admin = await createSuperAdmin();
    const noMfa = await request(app)
      .post("/auth/login")
      .send({ email: admin.email, password: admin.password });
    expect(noMfa.status).toBe(401);
    expect(noMfa.body.error.code).toBe("mfa_required");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: admin.email, password: admin.password, mfaCode: admin.totp() });
    expect(login.status).toBe(200);
    const adminToken: string = login.body.accessToken;

    // 4a. Verification is blocked until the required documents are present.
    const tooEarly = await request(app)
      .post(`/companies/${companyId}/verify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(tooEarly.status).toBe(400);

    // 4b. Upload a business document (DICA certificate) and an NRC copy.
    await request(app)
      .post(`/companies/${companyId}/documents`)
      .set("Authorization", `Bearer ${companyToken}`)
      .field("docType", "dica_certificate")
      .attach("file", Buffer.from("%PDF-1.4 test"), {
        filename: "dica.pdf",
        contentType: "application/pdf",
      })
      .expect(201);
    await request(app)
      .post(`/companies/${companyId}/documents`)
      .set("Authorization", `Bearer ${companyToken}`)
      .field("docType", "nrc")
      .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: "nrc.png",
        contentType: "image/png",
      })
      .expect(201);

    // 4c. Each document is reviewed and approved. Since 0020 an uploaded but
    // unreviewed file no longer satisfies the gate — a reviewer must open it.
    await approveCompanyDocuments(app, companyId, adminToken);

    // 4d. Now the Super Admin can verify the company against DICA.
    const verify = await request(app)
      .post(`/companies/${companyId}/verify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "Matched DICA record" });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe("verified");

    // 5. Now the verified employer can submit a Tier A check.
    const check = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${companyToken}`)
      .send({ subject: { fullName: "Jane Doe", nationalId: "12/ABC(N)123456" } });
    expect(check.status).toBe(201);
    expect(check.body.status).toBe("pending");
    const verificationId: string = check.body.id;

    // 6. And read it back.
    const get = await request(app)
      .get(`/verifications/${verificationId}`)
      .set("Authorization", `Bearer ${companyToken}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(verificationId);

    // 6b. Admin endpoints are closed to company users (RBAC boundary).
    const rbac = await request(app)
      .get("/admin/verifications")
      .set("Authorization", `Bearer ${companyToken}`);
    expect(rbac.status).toBe(403);

    // 6c. The check appears in the review queue and the admin completes it.
    // Searched by NRC rather than read off the first page: the queue is oldest
    // first and capped, so on a database with a real backlog the newest check
    // is not on page one — which is correct behaviour for a work queue.
    const queue = await request(app)
      .get(`/admin/verifications?status=pending&q=${encodeURIComponent("12/ABC(N)123456")}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((i: { id: string }) => i.id === verificationId)).toBe(true);

    const decide = await request(app)
      .post(`/admin/verifications/${verificationId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "completed", result: "Employment dates confirmed: 2021-03 to 2024-11" });
    expect(decide.status).toBe(200);
    expect(decide.body.status).toBe("completed");

    // 6d. Deciding twice conflicts — decisions are single-shot.
    const again = await request(app)
      .post(`/admin/verifications/${verificationId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "not_found" });
    expect(again.status).toBe(409);

    // 6e. The employer sees the outcome.
    const outcome = await request(app)
      .get(`/verifications/${verificationId}`)
      .set("Authorization", `Bearer ${companyToken}`);
    expect(outcome.body.status).toBe("completed");
    expect(outcome.body.result).toContain("Employment dates confirmed");

    // 6f. Super Admin reads the audit trail; the read is itself logged.
    const logs = await request(app)
      .get("/admin/audit-logs?limit=10&action=verification.decide")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(logs.status).toBe(200);
    expect(
      logs.body.items.some((e: { resourceId: string | null }) => e.resourceId === verificationId)
    ).toBe(true);
    const readLogged = await pool.query(
      `SELECT 1 FROM audit.audit_logs WHERE action = 'audit.read' AND actor_id = $1`,
      [admin.id]
    );
    expect(readLogged.rowCount).toBeGreaterThan(0);

    // 7. RLS: a DIFFERENT company cannot see the first company's verification.
    const other = await request(app).post("/companies").send(companyRegistrationPayload());
    const otherToken: string = other.body.accessToken;
    const leak = await request(app)
      .get(`/verifications/${verificationId}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(leak.status).toBe(404); // hidden by RLS, not merely by a check

    // 8. Audit: the check was recorded (transactional, not best-effort).
    const audit = await pool.query(
      `SELECT 1 FROM audit.audit_logs
        WHERE action = 'verification.create' AND resource_id = $1`,
      [verificationId]
    );
    expect(audit.rowCount).toBe(1);
  });

  it("rejects an invalid refresh token", async () => {
    const res = await request(app).post("/auth/refresh").send({ refreshToken: "nope" });
    expect(res.status).toBe(401);
  });

  it("keeps every Tier B surface behind the disabled feature flag", async () => {
    for (const [method, path] of [
      ["post", "/reports"],
      ["get", "/reports"],
      ["get", "/report-categories"],
      ["post", "/access-requests"],
      ["get", "/admin/reports/pending"],
    ] as const) {
      const res = await (method === "post"
        ? request(app).post(path).send({})
        : request(app).get(path));
      // /admin/* passes the Tier A admin router's auth first, so an
      // unauthenticated probe sees 401 there; everywhere else the flag guard
      // answers first with 403 feature_disabled. Either way: unreachable.
      expect([401, 403]).toContain(res.status);
      if (res.status === 403) expect(res.body.error.code).toBe("feature_disabled");
    }
  });
});
