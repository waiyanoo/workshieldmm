/**
 * The reviewer work queue.
 *
 * A flat list of everything pending is fine with four checks a day and useless
 * with four hundred. What a reviewer actually needs is: what is mine, what is
 * nobody's, what has been sitting too long, and what am I still waiting on the
 * employer for.
 *
 * Three ideas carry the rest of the file:
 *
 *   - ASSIGNMENT is a claim, not a schedule. A reviewer takes an item so two
 *     people don't research the same NRC in parallel; anyone can release it,
 *     and a claim never blocks a decision — an unassigned or someone else's
 *     item can still be decided, because a queue that can deadlock on someone
 *     being on leave is worse than a duplicated effort.
 *
 *   - NEED MORE INFO is a real lifecycle stop, not a note. The check is not
 *     pending (nobody should pick it up) and not decided (the employer owes an
 *     answer), and the clock on it belongs to the employer, not to us — which
 *     is why the turnaround figures below exclude that waiting time.
 *
 *   - TURNAROUND is measured, not asserted. `decided_at` on the row, median as
 *     well as mean: with a handful of stale items the mean tells you nothing
 *     about the typical wait, and the typical wait is the number an employer
 *     experiences.
 */
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { notify } from "../notifications/notifications.service";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export interface QueueFilters {
  status: string;
  /** "me" | "unassigned" | "all" | a specific reviewer id */
  assignment: string;
  /** Matches subject name, NRC, or company name. */
  q?: string;
  /** Only items older than N hours — the "what is overdue" view. */
  olderThanHours?: number;
  limit: number;
}

interface QueueRow {
  id: string;
  company_id: string;
  company_name: string;
  subject_id: string;
  subject_name: string;
  national_id: string | null;
  date_of_birth: string | null;
  status: string;
  result: string | null;
  created_at: string;
  decided_at: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  assigned_at: string | null;
  reviewer_note: string | null;
  info_request: string | null;
  info_requested_at: string | null;
  requested_by_name: string | null;
  age_hours: number;
}

function publicQueueItem(r: QueueRow) {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    subjectId: r.subject_id,
    subjectName: r.subject_name,
    nationalId: r.national_id,
    dateOfBirth: r.date_of_birth,
    status: r.status,
    result: r.result,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    assignedTo: r.assigned_to,
    assignedName: r.assigned_name,
    assignedAt: r.assigned_at,
    reviewerNote: r.reviewer_note,
    infoRequest: r.info_request,
    infoRequestedAt: r.info_requested_at,
    // Who at the employer asked, so a reviewer with a question knows whom to
    // chase rather than emailing a company mailbox.
    requestedByName: r.requested_by_name,
    ageHours: Math.round(r.age_hours * 10) / 10,
  };
}

export async function listQueue(admin: AuthUser, f: QueueFilters) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<QueueRow>(
      `SELECT v.id, v.company_id, v.subject_id, v.status, v.result, v.created_at,
              v.decided_at, v.assigned_to, v.assigned_at, v.reviewer_note,
              v.info_request, v.info_requested_at,
              c.legal_name AS company_name,
              s.full_name  AS subject_name, s.national_id, s.date_of_birth,
              p.full_name  AS assigned_name,
              ru.full_name AS requested_by_name,
              EXTRACT(EPOCH FROM (now() - v.created_at)) / 3600 AS age_hours
         FROM verification_requests v
         JOIN companies c ON c.id = v.company_id
         JOIN subjects  s ON s.id = v.subject_id
         LEFT JOIN platform_users p ON p.id = v.assigned_to
         LEFT JOIN company_users ru ON ru.id = v.requested_by
        WHERE ($1 = 'all' OR v.status = $1)
          -- Assignment filter in SQL rather than after the fact, so LIMIT
          -- counts the rows the reviewer will actually see. Written as one
          -- expression instead of interpolated clauses so the parameter list
          -- is fixed and nothing is ever concatenated into the statement.
          AND ($2 = 'all'
               OR ($2 = 'me' AND v.assigned_to = $6)
               OR ($2 = 'unassigned' AND v.assigned_to IS NULL)
               OR v.assigned_to::text = $2)
          AND ($3::text IS NULL OR
               s.full_name ILIKE '%' || $3 || '%' OR
               s.national_id ILIKE '%' || $3 || '%' OR
               c.legal_name ILIKE '%' || $3 || '%')
          AND ($4::int IS NULL OR v.created_at < now() - make_interval(hours => $4))
        ORDER BY
          -- Oldest first within the queue: a check that has waited three days
          -- should not stay behind one raised this morning.
          v.status = 'pending' DESC, v.created_at
        LIMIT $5`,
      [
        f.status,
        f.assignment,
        f.q?.trim() || null,
        f.olderThanHours ?? null,
        f.limit,
        admin.id,
      ]
    );

    return res.rows.map(publicQueueItem);
  });
}

/**
 * Counts and turnaround, for the strip above the queue.
 *
 * Turnaround excludes anything that spent time in `need_more_info`: that wait
 * is the employer's, and folding it in would make the team's own responsiveness
 * unreadable. Those items are counted separately so they cannot simply be
 * hidden either.
 */
export async function getQueueStats(admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const counts = await client.query<{ status: string; n: number; oldest: string | null }>(
      `SELECT status, count(*)::int AS n, min(created_at) AS oldest
         FROM verification_requests GROUP BY status`
    );

    const mine = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM verification_requests
        WHERE assigned_to = $1 AND status IN ('pending', 'need_more_info')`,
      [admin.id]
    );

    const unassigned = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM verification_requests
        WHERE assigned_to IS NULL AND status = 'pending'`
    );

    // Items that have waited more than a working day. This is the number worth
    // acting on, so it gets its own figure rather than being buried in a mean.
    const overdue = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM verification_requests
        WHERE status = 'pending' AND created_at < now() - interval '24 hours'`
    );

    const turnaround = await client.query<{
      decided: number;
      avg_hours: number | null;
      median_hours: number | null;
      p90_hours: number | null;
    }>(
      `SELECT count(*)::int AS decided,
              AVG(EXTRACT(EPOCH FROM (decided_at - created_at)) / 3600) AS avg_hours,
              PERCENTILE_CONT(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at)) / 3600
              ) AS median_hours,
              PERCENTILE_CONT(0.9) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at)) / 3600
              ) AS p90_hours
         FROM verification_requests
        WHERE decided_at IS NOT NULL
          AND info_requested_at IS NULL
          AND decided_at > now() - interval '30 days'`
    );

    const byStatus: Record<string, { count: number; oldest: string | null }> = {};
    for (const row of counts.rows) byStatus[row.status] = { count: row.n, oldest: row.oldest };

    const t = turnaround.rows[0]!;
    const round1 = (v: number | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);

    return {
      byStatus,
      mine: mine.rows[0]?.n ?? 0,
      unassigned: unassigned.rows[0]?.n ?? 0,
      overdue: overdue.rows[0]?.n ?? 0,
      turnaround: {
        // Last 30 days, excluding checks that waited on the employer.
        decided: t.decided,
        avgHours: round1(t.avg_hours),
        medianHours: round1(t.median_hours),
        p90Hours: round1(t.p90_hours),
      },
    };
  });
}

/** Reviewers, so the queue can be filtered by who holds what. */
export async function listReviewers(admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ id: string; full_name: string; open: number }>(
      `SELECT p.id, p.full_name,
              COALESCE(q.n, 0)::int AS open
         FROM platform_users p
         LEFT JOIN (
           SELECT assigned_to AS uid, count(*) AS n
             FROM verification_requests
            WHERE status IN ('pending', 'need_more_info') AND assigned_to IS NOT NULL
            GROUP BY assigned_to
         ) q ON q.uid = p.id
        WHERE p.role IN ('admin_reviewer', 'super_admin') AND p.status = 'active'
        ORDER BY p.full_name`
    );
    return res.rows.map((r) => ({ id: r.id, fullName: r.full_name, openItems: r.open }));
  });
}

/**
 * Claim an item, hand it to a named colleague, or release it.
 *
 * Claiming an item somebody else already holds is refused rather than silently
 * taken over — the point of a claim is that it tells you someone is already
 * looking. Reassignment is explicit (`to`), which makes it a decision and puts
 * a name in the audit log.
 */
export async function assignVerification(
  admin: AuthUser,
  verificationId: string,
  input: { to: string | null; force?: boolean; ip?: string | null }
) {
  return withContext(ctxForUser(admin), async (client) => {
    const current = await client.query<{ assigned_to: string | null; status: string }>(
      `SELECT assigned_to, status FROM verification_requests WHERE id = $1 FOR UPDATE`,
      [verificationId]
    );
    if (!current.rows[0]) throw notFound("Verification not found");
    if (!["pending", "need_more_info"].includes(current.rows[0].status)) {
      throw conflict("This check has already been decided");
    }

    const held = current.rows[0].assigned_to;
    if (input.to && held && held !== admin.id && held !== input.to && !input.force) {
      throw conflict("Another reviewer is already working on this check");
    }

    if (input.to) {
      const exists = await client.query(
        `SELECT 1 FROM platform_users
          WHERE id = $1 AND role IN ('admin_reviewer', 'super_admin') AND status = 'active'`,
        [input.to]
      );
      if (exists.rowCount === 0) throw badRequest("That reviewer does not exist or is not active");
    }

    await client.query(
      `UPDATE verification_requests
          SET assigned_to = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END
        WHERE id = $1`,
      [verificationId, input.to]
    );

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: input.to ? "verification.assigned" : "verification.released",
      resourceType: "verification_request",
      resourceId: verificationId,
      metadata: { to: input.to, from: held },
      ipAddress: input.ip ?? null,
    });

    return { id: verificationId, assignedTo: input.to };
  });
}

/**
 * A working note on the check.
 *
 * Internal: it is not shown to the employer and not part of the decision. It
 * exists so the reviewer who picks this up tomorrow knows what was already
 * tried — "called HR, line disconnected" saves the next person the call.
 */
export async function setReviewerNote(
  admin: AuthUser,
  verificationId: string,
  note: string,
  ip?: string | null
) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query(
      `UPDATE verification_requests SET reviewer_note = $2 WHERE id = $1 RETURNING id`,
      [verificationId, note.trim() || null]
    );
    if (!res.rows[0]) throw notFound("Verification not found");

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "verification.note",
      resourceType: "verification_request",
      resourceId: verificationId,
      // The note text stays on the row. Copying free text into an append-only
      // log means it can never be corrected if it names the wrong person.
      metadata: { cleared: note.trim().length === 0 },
      ipAddress: ip ?? null,
    });
    return { id: verificationId, reviewerNote: note.trim() || null };
  });
}

/**
 * Ask the employer for more information.
 *
 * Moves the check out of `pending` so it stops appearing as work the team owes
 * an answer on, and notifies the requesting company with the actual question.
 * The employer answers, which puts it back in `pending` (see `respondToInfoRequest`).
 */
export async function requestMoreInfo(
  admin: AuthUser,
  verificationId: string,
  question: string,
  ip?: string | null
) {
  const text = question.trim();
  if (!text) throw badRequest("Say what you need from the employer");

  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ company_id: string }>(
      `UPDATE verification_requests
          SET status = 'need_more_info', info_request = $2, info_requested_at = now(),
              assigned_to = COALESCE(assigned_to, $3),
              assigned_at = COALESCE(assigned_at, now())
        WHERE id = $1 AND status = 'pending'
        RETURNING company_id`,
      [verificationId, text, admin.id]
    );
    if (!res.rows[0]) {
      const exists = await client.query<{ status: string }>(
        `SELECT status FROM verification_requests WHERE id = $1`,
        [verificationId]
      );
      if (!exists.rows[0]) throw notFound("Verification not found");
      throw conflict(`This check is ${exists.rows[0].status}, not pending`);
    }

    await notify(client, {
      companyId: res.rows[0].company_id,
      kind: "verification.info_requested",
      params: { question: text },
      severity: "warning",
      link: "/verifications",
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "verification.info_requested",
      resourceType: "verification_request",
      resourceId: verificationId,
      ipAddress: ip ?? null,
    });

    return { id: verificationId, status: "need_more_info" as const, infoRequest: text };
  });
}

/**
 * The employer answers the question, and the check rejoins the queue.
 *
 * Called by the company, not by a reviewer — this is the other half of
 * `requestMoreInfo`. `info_requested_at` is deliberately left set: it is the
 * marker that excludes this check from the turnaround figures, since part of
 * its wait was ours to measure and part of it was not.
 */
export async function respondToInfoRequest(
  user: AuthUser,
  verificationId: string,
  answer: string,
  ip?: string | null
) {
  const text = answer.trim();
  if (!text) throw badRequest("Enter your answer");

  return withContext(ctxForUser(user), async (client) => {
    // RLS already restricts this to the caller's own company.
    const res = await client.query<{ assigned_to: string | null; info_request: string | null }>(
      `SELECT assigned_to, info_request FROM verification_requests
        WHERE id = $1 AND status = 'need_more_info' FOR UPDATE`,
      [verificationId]
    );
    if (!res.rows[0]) {
      throw notFound("No check of yours is waiting for more information");
    }

    // The answer is appended to the reviewer's note rather than overwriting the
    // question: the reviewer needs to see what was asked next to what came back.
    await client.query(
      `UPDATE verification_requests
          SET status = 'pending',
              reviewer_note = COALESCE(reviewer_note || E'\n\n', '') ||
                              'Employer replied: ' || $2
        WHERE id = $1`,
      [verificationId, text]
    );

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "verification.info_provided",
      resourceType: "verification_request",
      resourceId: verificationId,
      ipAddress: ip ?? null,
    });

    return { id: verificationId, status: "pending" as const };
  });
}
