import { env } from "../../config/env";
import { query, withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import type { AuthUser } from "../../types/auth";

export interface FeatureSettings {
  tierB: boolean;
  teamInvites: boolean;
}

const defaults = (): FeatureSettings => ({
  tierB: env.FEATURE_TIER_B_ENABLED,
  teamInvites: env.FEATURE_TEAM_INVITES_ENABLED,
});

let cache: { value: FeatureSettings; expiresAt: number } | null = null;

export async function getFeatureSettings(force = false): Promise<FeatureSettings> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value;
  const rows = await query<{ key: "tier_b" | "team_invites"; enabled: boolean }>(
    `SELECT key, enabled FROM platform_feature_settings WHERE key IN ('tier_b', 'team_invites')`
  );
  const value = defaults();
  for (const row of rows) {
    if (row.key === "tier_b") value.tierB = row.enabled;
    if (row.key === "team_invites") value.teamInvites = row.enabled;
  }
  cache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export async function updateFeatureSettings(
  admin: AuthUser,
  next: FeatureSettings,
  ip?: string | null
): Promise<FeatureSettings> {
  const previous = await getFeatureSettings(true);
  await withContext(ctxForUser(admin), async (client) => {
    for (const [key, enabled] of [["tier_b", next.tierB], ["team_invites", next.teamInvites]] as const) {
      await client.query(
        `INSERT INTO platform_feature_settings (key, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, enabled, admin.id]
      );
    }
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "settings.features.update",
      resourceType: "platform_settings",
      metadata: { previous, next },
      ipAddress: ip ?? null,
    });
  });
  cache = { value: next, expiresAt: Date.now() + 5_000 };
  return next;
}
