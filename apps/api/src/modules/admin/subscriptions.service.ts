/**
 * Subscription entitlement provisioning (Super Admin). A Tier B subscription
 * is necessary but NOT sufficient to use Tier B — the feature flag and the
 * verified-company gate still apply at every Tier B endpoint. (§7)
 */
import { withContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";

export async function grantSubscription(
  admin: AuthUser,
  companyId: string,
  tier: "A" | "B",
  ip?: string | null
) {
  return withContext(
    { userType: admin.userType, userId: admin.id, companyId: admin.companyId },
    async (client) => {
      const company = await client.query(`SELECT 1 FROM companies WHERE id = $1`, [companyId]);
      if (company.rowCount === 0) throw notFound("Company not found");

      // ON CONFLICT against the partial unique index keeps this idempotent
      // without aborting the transaction on a duplicate grant.
      const res = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (company_id, tier, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (company_id, tier) WHERE status = 'active' DO NOTHING
         RETURNING id`,
        [companyId, tier]
      );

      if (!res.rows[0]) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM subscriptions
            WHERE company_id = $1 AND tier = $2 AND status = 'active'`,
          [companyId, tier]
        );
        return { id: existing.rows[0]!.id, tier, status: "active", created: false };
      }

      await writeAudit(client, {
        actorId: admin.id,
        actorType: "admin",
        action: "subscription.grant",
        resourceType: "subscription",
        resourceId: res.rows[0].id,
        metadata: { companyId, tier },
        ipAddress: ip ?? null,
      });
      return { id: res.rows[0].id, tier, status: "active", created: true };
    }
  );
}
