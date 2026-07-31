/**
 * In-app notifications.
 *
 * Messages are stored as a `kind` plus params, never as rendered text. The
 * platform is bilingual, so a sentence written in English when the event
 * happened would still be English when a Burmese-speaking user opens it later.
 * The client translates `notify.<kind>` with the params at read time.
 *
 * Delivery to email / Viber / Telegram is not wired up. The rows here are the
 * queue those channels would drain, so adding one later means reading this
 * table rather than finding every place an event is raised.
 */
import type { PoolClient } from "pg";
import { withContext, type AppContext } from "../../db/pool";
import { forbidden } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";

export type NotificationKind =
  | "documents.missing"
  | "document.rejected"
  | "document.approved"
  | "company.verified"
  | "company.suspended"
  | "payment.confirmed"
  | "payment.rejected"
  | "verification.completed"
  | "verification.info_requested"
  | "report.accepted"
  | "report.rejected";

export interface NotifyInput {
  companyId: string;
  kind: NotificationKind;
  params?: Record<string, unknown>;
  link?: string;
  severity?: "info" | "success" | "warning" | "error";
  /** Target one person instead of the whole company. */
  userId?: string;
}

/**
 * Raise a notification inside the caller's transaction.
 *
 * Deliberately takes an open client: a notice about something that then failed
 * to commit is worse than no notice, so the two either land together or not at
 * all.
 */
export async function notify(client: PoolClient, input: NotifyInput): Promise<void> {
  await client.query(
    `INSERT INTO notifications (company_id, user_id, kind, params, link, severity)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.companyId,
      input.userId ?? null,
      input.kind,
      JSON.stringify(input.params ?? {}),
      input.link ?? null,
      input.severity ?? "info",
    ]
  );
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export async function listNotifications(user: AuthUser, limit = 30) {
  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{
      id: string;
      kind: string;
      params: Record<string, unknown>;
      link: string | null;
      severity: string;
      read_at: string | null;
      created_at: string;
    }>(
      // Company-wide notices plus anything addressed to this person specifically.
      `SELECT id, kind, params, link, severity, read_at, created_at
         FROM notifications
        WHERE company_id = $1 AND (user_id IS NULL OR user_id = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [user.companyId, user.id, limit]
    );

    const unread = await client.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM notifications
        WHERE company_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL`,
      [user.companyId, user.id]
    );

    return {
      unread: Number(unread.rows[0]?.count ?? 0),
      items: res.rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        params: n.params,
        link: n.link,
        severity: n.severity,
        readAt: n.read_at,
        createdAt: n.created_at,
      })),
    };
  });
}

export async function markRead(user: AuthUser, id: string) {
  if (!user.companyId) throw forbidden("A company context is required");
  return withContext(ctxForUser(user), async (client) => {
    await client.query(
      `UPDATE notifications SET read_at = now()
        WHERE id = $1 AND company_id = $2 AND read_at IS NULL`,
      [id, user.companyId]
    );
    return { id, read: true };
  });
}

export async function markAllRead(user: AuthUser) {
  if (!user.companyId) throw forbidden("A company context is required");
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query(
      `UPDATE notifications SET read_at = now()
        WHERE company_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL`,
      [user.companyId, user.id]
    );
    return { marked: res.rowCount ?? 0 };
  });
}
