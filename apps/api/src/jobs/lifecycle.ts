/**
 * Report lifecycle sweep — a pure, idempotent function run by the worker on a
 * schedule (and callable directly from tests).
 *
 * expireReports: retention is enforced by a scheduled job that anonymizes
 * expired records automatically, not manually. (§5) Runs under the 'system'
 * RLS context and audits every transition.
 */
import { withContext } from "../db/pool";
import { writeAudit } from "../lib/audit";

export async function expireReports(): Promise<string[]> {
  return withContext({ userType: "system" }, async (client) => {
    const res = await client.query<{ id: string }>(
      `UPDATE conduct_reports
          SET status = 'expired',
              narrative_summary = NULL
        WHERE status = 'approved'
          AND expiry_date < now()
        RETURNING id`
    );
    for (const row of res.rows) {
      // Purge the evidence linkage; the objects themselves are removed from
      // storage by the retention tooling (see §8 open decisions).
      await client.query(`DELETE FROM evidence_files WHERE report_id = $1`, [row.id]);
      await writeAudit(client, {
        actorType: "system",
        action: "report.expire",
        resourceType: "conduct_report",
        resourceId: row.id,
        metadata: { reason: "retention window elapsed" },
      });
    }
    return res.rows.map((r) => r.id);
  });
}

/**
 * Warn Super Admins before a promotion ends.
 *
 * When the launch offer lapses, every plan and credit pack jumps back to list
 * price — a 43% rise for anyone on 30% off — and nothing announces it. That is
 * a conversation to have with customers beforehand, not a surprise on their
 * next invoice.
 *
 * Idempotent through the notice's dedupe key: this runs every fifteen minutes
 * and must announce each promotion once, not ninety-six times a day.
 */
export async function warnExpiringPromotions(daysAhead = 14): Promise<string[]> {
  return withContext({ userType: "system" }, async (client) => {
    const due = await client.query<{ id: string; name: string; ends_at: string; percent_off: number }>(
      `SELECT id, name, ends_at, percent_off
         FROM pricing_promotions
        WHERE active
          AND now() >= starts_at
          AND ends_at > now()
          AND ends_at <= now() + make_interval(days => $1)`,
      [daysAhead]
    );

    const warned: string[] = [];
    for (const promo of due.rows) {
      const res = await client.query(
        `INSERT INTO notifications (audience, kind, params, link, severity, dedupe_key)
         VALUES ('platform_admin', 'promotion.ending_soon', $1, '/admin/promotions', 'warning', $2)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          JSON.stringify({
            name: promo.name,
            percent: promo.percent_off,
            endsAt: promo.ends_at,
          }),
          // Keyed on the promotion and its end date, so moving the end date
          // legitimately raises a fresh warning for the new one.
          `promo-ending:${promo.id}:${promo.ends_at}`,
        ]
      );
      if (res.rowCount) warned.push(promo.id);
    }
    return warned;
  });
}
