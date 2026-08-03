import { withContext, type AppContext } from "../../db/pool";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/** A single, live operating picture for the queues that require platform action.
 * The target is intentionally explicit per workflow rather than a hidden magic
 * number, so a team can see exactly what "overdue" means. */
export async function getOperationalSummary(admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const result = await client.query<{
      key: string;
      sla_hours: number;
      open: number;
      overdue: number;
      oldest_opened_at: string | null;
    }>(
      `SELECT 'verifications' AS key, 24::int AS sla_hours,
              count(*) FILTER (WHERE status = 'pending')::int AS open,
              count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '24 hours')::int AS overdue,
              min(created_at) FILTER (WHERE status = 'pending') AS oldest_opened_at
         FROM verification_requests
       UNION ALL
       SELECT 'payments', 24::int,
              count(*) FILTER (WHERE status = 'submitted')::int,
              count(*) FILTER (WHERE status = 'submitted' AND submitted_at < now() - interval '24 hours')::int,
              min(submitted_at) FILTER (WHERE status = 'submitted')
         FROM payment_intents
       UNION ALL
       SELECT 'reports', 48::int,
              count(*) FILTER (WHERE status = 'pending_review')::int,
              count(*) FILTER (WHERE status = 'pending_review' AND created_at < now() - interval '48 hours')::int,
              min(created_at) FILTER (WHERE status = 'pending_review')
         FROM conduct_reports`
    );
    return {
      queues: result.rows.map((r) => ({
        key: r.key,
        slaHours: r.sla_hours,
        open: r.open,
        overdue: r.overdue,
        oldestOpenedAt: r.oldest_opened_at,
      })),
      overdueTotal: result.rows.reduce((total, row) => total + row.overdue, 0),
    };
  });
}
