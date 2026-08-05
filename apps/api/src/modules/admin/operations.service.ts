import { withContext, type AppContext } from "../../db/pool";
import type { AuthUser } from "../../types/auth";
import { getFeatureSettings } from "./settings.service";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/** A single, live operating picture for the queues that require platform action.
 * The target is intentionally explicit per workflow rather than a hidden magic
 * number, so a team can see exactly what "overdue" means. */
export async function getOperationalSummary(admin: AuthUser) {
  const features = await getFeatureSettings();
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
       SELECT 'companies', 24::int,
              count(*) FILTER (WHERE status = 'pending')::int,
              count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '24 hours')::int,
              min(created_at) FILTER (WHERE status = 'pending')
         FROM companies
       UNION ALL
       SELECT 'reports', 48::int,
              count(*) FILTER (WHERE status = 'pending_review')::int,
              count(*) FILTER (WHERE status = 'pending_review' AND created_at < now() - interval '48 hours')::int,
              min(created_at) FILTER (WHERE status = 'pending_review')
         FROM conduct_reports`
    );
    const rows = result.rows.filter((row) =>
      (features.tierB || row.key !== "reports") &&
      (admin.role === "super_admin" || row.key !== "companies")
    );
    const work = await client.query<{
      kind: "verification" | "payment" | "company" | "report";
      id: string;
      title: string;
      subtitle: string;
      reference: string | null;
      opened_at: string;
      sla_hours: number;
      assigned_to: string | null;
      assigned_name: string | null;
    }>(
      `SELECT kind, id, title, subtitle, reference, opened_at, sla_hours, assigned_to, assigned_name FROM (
         SELECT work.*, row_number() OVER (PARTITION BY kind ORDER BY opened_at) AS queue_rank FROM (
         SELECT 'verification'::text AS kind, v.id, s.full_name AS title,
                c.legal_name AS subtitle, s.national_id AS reference,
                v.created_at AS opened_at, 24::int AS sla_hours,
                v.assigned_to, pu.full_name AS assigned_name
           FROM verification_requests v
           JOIN subjects s ON s.id = v.subject_id
           JOIN companies c ON c.id = v.company_id
           LEFT JOIN platform_users pu ON pu.id = v.assigned_to
          WHERE v.status = 'pending'
         UNION ALL
         SELECT 'payment', p.id, c.legal_name, p.provider,
                p.reference_code, COALESCE(p.submitted_at, p.created_at), 24,
                NULL::uuid, NULL::text
           FROM payment_intents p
           JOIN companies c ON c.id = p.company_id
          WHERE p.status = 'submitted'
         UNION ALL
         SELECT 'company', c.id, c.legal_name, 'DICA registration',
                c.registration_number, c.created_at, 24, NULL::uuid, NULL::text
           FROM companies c
          WHERE c.status = 'pending' AND $1::boolean
         UNION ALL
         SELECT 'report', r.id, s.full_name, c.legal_name,
                rc.name, COALESCE(r.submitted_at, r.created_at), 48, NULL::uuid, NULL::text
           FROM conduct_reports r
           JOIN subjects s ON s.id = r.subject_id
           JOIN companies c ON c.id = r.submitted_by_company_id
           JOIN report_categories rc ON rc.id = r.category_id
          WHERE r.status = 'pending_review' AND $2::boolean
       ) work) ranked
       WHERE queue_rank <= 6
       ORDER BY (opened_at < now() - make_interval(hours => sla_hours)) DESC, opened_at
       LIMIT 25`,
      [admin.role === "super_admin", features.tierB]
    );
    return {
      queues: rows.map((r) => ({
        key: r.key,
        slaHours: r.sla_hours,
        open: r.open,
        overdue: r.overdue,
        oldestOpenedAt: r.oldest_opened_at,
      })),
      overdueTotal: rows.reduce((total, row) => total + row.overdue, 0),
      workItems: work.rows.map((item) => ({
        kind: item.kind,
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        reference: item.reference,
        openedAt: item.opened_at,
        slaHours: item.sla_hours,
        assignedTo: item.assigned_to,
        assignedName: item.assigned_name,
      })),
    };
  });
}
