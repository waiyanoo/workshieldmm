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
