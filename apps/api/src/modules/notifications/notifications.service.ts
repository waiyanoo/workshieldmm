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
  | "report.rejected"
  // Addressed to platform staff rather than to a company. (0032)
  | "payment.awaiting_confirmation"
  | "company.documents_ready"
  | "promotion.ending_soon";

/**
 * Who a notice is for.
 *
 * `platform_review` and `platform_admin` mirror the two role guards the API
 * already uses, so the audience of a notice and the people allowed to act on it
 * cannot drift apart.
 */
export type NotificationAudience = "company" | "platform_review" | "platform_admin";

/** Which audiences a platform role reads. Company users read neither. */
const AUDIENCES_FOR_ROLE: Record<string, NotificationAudience[]> = {
  super_admin: ["platform_review", "platform_admin"],
  admin_reviewer: ["platform_review"],
};

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

export interface NotifyPlatformInput {
  audience: Exclude<NotificationAudience, "company">;
  kind: NotificationKind;
  params?: Record<string, unknown>;
  link?: string;
  severity?: "info" | "success" | "warning" | "error";
  /** The company the notice is about, when there is one. */
  companyId?: string | null;
  /**
   * Raise this notice at most once. Give a key derived from the thing being
   * announced (`promo-ending:<id>`), not from the moment — a repeatable sweep
   * would otherwise re-announce the same fact on every pass.
   */
  dedupeKey?: string;
}

/**
 * Raise a notification for platform staff, in the caller's transaction.
 *
 * Read state is shared across the audience: these are shared work items, and
 * once one reviewer has dealt with a payment the others do not need telling.
 */
export async function notifyPlatform(
  client: PoolClient,
  input: NotifyPlatformInput
): Promise<void> {
  // ON CONFLICT only when a key was given. It is not free: Postgres applies the
  // policy's USING clause as well as its WITH CHECK for a conflict-handling
  // insert, and a company context deliberately cannot READ platform notices —
  // so the clause would refuse the very inserts a company action raises. Only
  // the repeatable sweep needs deduplication, and it runs as the system.
  const onConflict = input.dedupeKey
    ? "ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING"
    : "";
  await client.query(
    `INSERT INTO notifications (audience, company_id, kind, params, link, severity, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ${onConflict}`,
    [
      input.audience,
      input.companyId ?? null,
      input.kind,
      JSON.stringify(input.params ?? {}),
      input.link ?? null,
      input.severity ?? "info",
      input.dedupeKey ?? null,
    ]
  );
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/**
 * A notice as the client consumes it. Identical shape for both audiences, so
 * one bell component serves everyone.
 */
interface NotificationRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  link: string | null;
  severity: string;
  read_at: string | null;
  created_at: string;
}

function toItems(rows: NotificationRow[]) {
  return rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    params: n.params,
    link: n.link,
    severity: n.severity,
    readAt: n.read_at,
    createdAt: n.created_at,
  }));
}

/** The audiences this user reads, or null if they read notifications at all. */
function audiencesFor(user: AuthUser): NotificationAudience[] | null {
  if (user.userType === "company") return null;
  return AUDIENCES_FOR_ROLE[user.role] ?? [];
}

export async function listNotifications(user: AuthUser, limit = 30) {
  const audiences = audiencesFor(user);

  if (audiences) {
    // Platform staff. A role with no audiences gets an empty, working bell
    // rather than an error — nothing is wrong, there is simply nothing for it.
    return withContext(ctxForUser(user), async (client) => {
      const res = await client.query<NotificationRow>(
        `SELECT id, kind, params, link, severity, read_at, created_at
           FROM notifications
          WHERE audience = ANY($1::text[])
          ORDER BY created_at DESC
          LIMIT $2`,
        [audiences, limit]
      );
      const unread = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM notifications
          WHERE audience = ANY($1::text[]) AND read_at IS NULL`,
        [audiences]
      );
      return { unread: Number(unread.rows[0]?.count ?? 0), items: toItems(res.rows) };
    });
  }

  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<NotificationRow>(
      // Company-wide notices plus anything addressed to this person specifically.
      // Platform notices about this company are excluded by `audience`, not
      // merely by convention — RLS refuses them as well.
      `SELECT id, kind, params, link, severity, read_at, created_at
         FROM notifications
        WHERE audience = 'company' AND company_id = $1 AND (user_id IS NULL OR user_id = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [user.companyId, user.id, limit]
    );

    const unread = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications
        WHERE audience = 'company' AND company_id = $1 AND (user_id IS NULL OR user_id = $2)
          AND read_at IS NULL`,
      [user.companyId, user.id]
    );

    return { unread: Number(unread.rows[0]?.count ?? 0), items: toItems(res.rows) };
  });
}

export async function markRead(user: AuthUser, id: string) {
  const audiences = audiencesFor(user);

  if (audiences) {
    return withContext(ctxForUser(user), async (client) => {
      await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE id = $1 AND audience = ANY($2::text[]) AND read_at IS NULL`,
        [id, audiences]
      );
      return { id, read: true };
    });
  }

  if (!user.companyId) throw forbidden("A company context is required");
  return withContext(ctxForUser(user), async (client) => {
    await client.query(
      `UPDATE notifications SET read_at = now()
        WHERE id = $1 AND audience = 'company' AND company_id = $2 AND read_at IS NULL`,
      [id, user.companyId]
    );
    return { id, read: true };
  });
}

export async function markAllRead(user: AuthUser) {
  const audiences = audiencesFor(user);

  if (audiences) {
    return withContext(ctxForUser(user), async (client) => {
      const res = await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE audience = ANY($1::text[]) AND read_at IS NULL`,
        [audiences]
      );
      return { marked: res.rowCount ?? 0 };
    });
  }

  if (!user.companyId) throw forbidden("A company context is required");
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query(
      `UPDATE notifications SET read_at = now()
        WHERE audience = 'company' AND company_id = $1 AND (user_id IS NULL OR user_id = $2)
          AND read_at IS NULL`,
      [user.companyId, user.id]
    );
    return { marked: res.rowCount ?? 0 };
  });
}
