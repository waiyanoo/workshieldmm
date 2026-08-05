/**
 * Which browser origins may call this API.
 *
 * This was `app.use(cors())` — every origin, unconditionally. The API is
 * bearer-token rather than cookie authenticated, so that was not the same hole
 * it would be for a session-cookie app, but it let any page on the internet
 * script this API against a token it had obtained, and a misconfigured
 * deployment looked perfectly healthy.
 *
 * Two things are easy to get wrong when tightening this, and both are pinned
 * here: requests with no Origin at all must keep working (health checks), and
 * the preflight has to permit the Authorization header, or every authenticated
 * cross-origin call fails while simple GETs appear fine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

// Set before the app is imported: config/env freezes on first read.
process.env.CORS_ORIGINS = "https://app.workshield.mm, https://admin.workshield.mm/";

let app: Express;
let pool: typeof import("../db/pool").pool;
let redis: typeof import("../lib/redis").redis;

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
});

afterAll(async () => {
  await Promise.allSettled([pool.end(), redis.quit()]);
});

describe("cross-origin access", () => {
  it("allows a configured origin", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://app.workshield.mm")
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.workshield.mm");
  });

  it("tolerates a trailing slash in configuration", async () => {
    // Copied from a browser address bar, an origin often arrives with one.
    // Rejecting on that would be a genuinely baffling outage.
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://admin.workshield.mm")
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://admin.workshield.mm");
  });

  it("gives an unlisted origin no access-control headers", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example.com");
    // Answered normally — the browser is what refuses the response, and a 500
    // here would move someone else's misbehaviour into our error logs.
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still serves requests with no Origin at all", async () => {
    // Load balancer probes, curl, server-to-server. CORS constrains what a
    // browser lets one page do to another; it is not a control over these, and
    // blocking them would break readiness while securing nothing.
    const res = await request(app).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
  });

  it("permits a bearer token on the preflight", async () => {
    const res = await request(app)
      .options("/verifications")
      .set("Origin", "https://app.workshield.mm")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");

    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.workshield.mm");
    const allowedHeaders = (res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    // Without this the app authenticates fine same-origin and fails entirely
    // once the API is on its own hostname.
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("content-type");
    expect((res.headers["access-control-allow-methods"] ?? "")).toContain("POST");
  });

  it("does not offer credentials mode", async () => {
    // Nothing rides on cookies; allowing them would widen the surface for no
    // benefit and cannot be combined with a wildcard anyway.
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://app.workshield.mm")
      .expect(200);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
