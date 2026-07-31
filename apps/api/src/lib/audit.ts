/**
 * Transactional audit writer.
 *
 * Takes the SAME PoolClient as the state change it records, so the audit entry
 * and the change commit or roll back together — audit is not a best-effort side
 * effect. (§4) Metadata must never contain raw evidence or PII — references
 * only.
 */
import type { PoolClient } from "pg";
import type { ActorType } from "@hyper/shared";

export interface AuditEntry {
  actorId?: string | null;
  actorType: ActorType;
  action: string; // e.g. "company.verify"
  resourceType: string; // e.g. "company"
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit.audit_logs
       (actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorId ?? null,
      entry.actorType,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.ipAddress ?? null,
    ]
  );
}
