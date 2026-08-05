/**
 * The runtime kill switches.
 *
 * Tier B carries unresolved legal exposure, so being able to turn it off must
 * work — and must keep working. Since 0031 the switch is a database row rather
 * than only an environment variable, which means a redeploy is no longer needed
 * to pull the feature, and also that a bug here fails silently: the flag would
 * read as on, every conduct-report endpoint would answer, and nothing would
 * look broken.
 *
 * What is pinned:
 *   - flipping the switch takes effect on live requests, both ways;
 *   - it is role-blind — a Super Admin cannot reach Tier B while it is off;
 *   - only a Super Admin can move it;
 *   - with no row saved, the environment variable still decides.
 *
 * The switch is restored in a finally block. Test files share a database and
 * run in sequence, so leaving Tier B off here would fail every Tier B test that
 * follows for reasons having nothing to do with them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.FEATURE_TIER_B_ENABLED = "true";

let app: Express;
let pool: typeof import("../db/pool").pool;
let withContext: typeof import("../db/pool").withContext;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
});

afterAll(async () => {
  await Promise.allSettled([pool.end(), redis.quit()]);
});

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/**
 * Delete the saved rows so the flags fall back to the environment, which is the
 * state every other test file expects to find.
 */
async function clearSavedSettings(): Promise<void> {
  await withContext({ userType: "platform" }, (c) =>
    c.query(`DELETE FROM platform_feature_settings`)
  );
  // The service caches for 5 seconds; force a read so the next request sees
  // the cleared state rather than the value this file just wrote.
  const { getFeatureSettings } = await import("./admin/settings.service");
  await getFeatureSettings(true);
}

describe("feature kill switches", () => {
  it("turns Tier B off and on for live requests, for everyone", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());

    try {
      // On to begin with — either from the environment or a saved row.
      await request(app)
        .get("/report-categories")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const off = await request(app)
        .patch("/admin/settings/features")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ tierB: false, teamInvites: true })
        .expect(200);
      expect(off.body.tierB).toBe(false);

      // Role-blind: the account that threw the switch is refused with everyone
      // else. Tier B is a deployment decision, not a permission Super Admins
      // outrank — that is the whole point of the control.
      const blocked = await request(app)
        .get("/report-categories")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe("feature_disabled");

      // Reports themselves, not just the lookup table.
      const reports = await request(app)
        .get("/reports")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(reports.status).toBe(403);

      // And back on again, without a restart.
      await request(app)
        .patch("/admin/settings/features")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ tierB: true, teamInvites: true })
        .expect(200);
      await request(app)
        .get("/report-categories")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
    } finally {
      await clearSavedSettings();
    }
  });

  it("is not something a reviewer can touch", async () => {
    const reviewerToken = await loginPlatform(
      await helpers.createPlatformUser("admin_reviewer")
    );

    const read = await request(app)
      .get("/admin/settings/features")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(read.status).toBe(403);

    const write = await request(app)
      .patch("/admin/settings/features")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ tierB: false, teamInvites: false });
    expect(write.status).toBe(403);

    // Refused, so nothing was saved and the feature is still reachable.
    const rows = await withContext({ userType: "platform" }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM platform_feature_settings`)
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("records who moved it, and what it was before", async () => {
    const admin = await helpers.createSuperAdmin();
    const adminToken = await loginPlatform(admin);

    try {
      await request(app)
        .patch("/admin/settings/features")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ tierB: false, teamInvites: false })
        .expect(200);

      const audit = await request(app)
        .get("/admin/audit-logs?action=settings.features.update")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const entry = audit.body.items.find(
        (a: { actorId: string | null }) => a.actorId === admin.id
      );
      expect(entry).toBeTruthy();
      // Before and after both, so the log answers "what changed" rather than
      // only "someone saved the settings page".
      expect(entry.metadata.previous).toBeTruthy();
      expect(entry.metadata.next).toMatchObject({ tierB: false, teamInvites: false });

      const saved = await withContext({ userType: "platform" }, (c) =>
        c.query<{ key: string; updated_by: string }>(
          `SELECT key, updated_by FROM platform_feature_settings ORDER BY key`
        )
      );
      expect(saved.rows.map((r) => r.key)).toEqual(["team_invites", "tier_b"]);
      expect(saved.rows.every((r) => r.updated_by === admin.id)).toBe(true);
    } finally {
      await clearSavedSettings();
    }
  });

  it("falls back to the environment when nothing has been saved", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    await clearSavedSettings();

    // No rows: deploying 0031 must not change what a running system does, which
    // is why the table starts empty rather than seeded with defaults.
    const rows = await withContext({ userType: "platform" }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM platform_feature_settings`)
    );
    expect(rows.rows[0]!.n).toBe(0);

    const features = await request(app)
      .get("/admin/settings/features")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(features.body.tierB).toBe(process.env.FEATURE_TIER_B_ENABLED === "true");
  });
});
