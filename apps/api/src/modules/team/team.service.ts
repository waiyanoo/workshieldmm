/**
 * Company team management.
 *
 * A company is not one person. HR runs the checks, a manager files the reports,
 * and both leave the company eventually. Three things follow from that, and
 * they are the whole of this module:
 *
 *   1. Access is granted by invitation, not by handing the admin password
 *      around. The invite carries the role, so a recruiter never silently
 *      becomes an administrator.
 *   2. Access is removable the day someone leaves. Deactivation revokes their
 *      refresh tokens in the same transaction, so a live session dies with the
 *      account rather than lasting until the token expires.
 *   3. Every check and every report is attributable to a named person. Reports
 *      are allegations about someone's conduct; "the company said it" is not an
 *      acceptable answer when one turns out to be wrong.
 *
 * Deactivate, never delete: the checks and reports a former colleague filed
 * still need an author. `status = 'suspended'` is refused at login (see
 * auth.service) and keeps the attribution intact.
 */
import { createHash, randomBytes } from "node:crypto";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { isUniqueViolation } from "../../lib/dbErrors";
import { hashPassword } from "../auth/password";
import { env } from "../../config/env";
import type { AuthUser } from "../../types/auth";

const SYSTEM_CTX: AppContext = { userType: "system" };

/** Long enough that guessing is hopeless; the row also expires. */
const INVITE_TTL_DAYS = 7;

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/**
 * Only the hash is stored. An invite token creates an account, so it is a
 * credential: a database dump must not yield working invitations.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requireCompanyAdmin(user: AuthUser): string {
  if (!user.companyId) throw forbidden("A company context is required");
  if (user.role !== "company_admin") {
    throw forbidden("Only a company admin can manage team access");
  }
  return user.companyId;
}

// --- Reading the team ---------------------------------------------------------

export async function listTeam(user: AuthUser) {
  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    // Activity counts alongside each person: this is the "who submitted what"
    // question, answered at a glance. The detail is a click away below.
    const users = await client.query<{
      id: string;
      full_name: string;
      email: string;
      role: string;
      status: string;
      mfa_enabled: boolean;
      phone: string | null;
      created_at: string;
      checks: number;
      reports: number;
      last_activity: string | null;
    }>(
      `SELECT u.id, u.full_name, u.email, u.role, u.status, u.mfa_enabled, u.phone,
              u.created_at,
              COALESCE(v.n, 0)::int AS checks,
              COALESCE(r.n, 0)::int AS reports,
              GREATEST(v.last_at, r.last_at) AS last_activity
         FROM company_users u
         LEFT JOIN (
           SELECT requested_by AS uid, count(*) AS n, max(created_at) AS last_at
             FROM verification_requests WHERE company_id = $1 GROUP BY requested_by
         ) v ON v.uid = u.id
         LEFT JOIN (
           SELECT submitted_by_user_id AS uid, count(*) AS n, max(created_at) AS last_at
             FROM conduct_reports
            WHERE submitted_by_company_id = $1 AND submitted_by_user_id IS NOT NULL
            GROUP BY submitted_by_user_id
         ) r ON r.uid = u.id
        WHERE u.company_id = $1
        ORDER BY u.status, u.created_at`,
      [user.companyId]
    );

    // Invitations that are still usable. Accepted and revoked ones are history
    // and belong in the audit log, not in a list of who can get in.
    const invites = await client.query<{
      id: string;
      email: string;
      role: string;
      full_name: string | null;
      expires_at: string;
      created_at: string;
      invited_by_name: string | null;
    }>(
      `SELECT i.id, i.email, i.role, i.full_name, i.expires_at, i.created_at,
              u.full_name AS invited_by_name
         FROM company_user_invites i
         LEFT JOIN company_users u ON u.id = i.invited_by
        WHERE i.company_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        ORDER BY i.created_at DESC`,
      [user.companyId]
    );

    return {
      canManage: user.role === "company_admin",
      // Advertised so the screen can leave the invite controls out entirely
      // rather than showing a button that returns 403.
      invitesEnabled: env.FEATURE_TEAM_INVITES_ENABLED,
      members: users.rows.map((u) => ({
        id: u.id,
        fullName: u.full_name,
        email: u.email,
        role: u.role,
        status: u.status,
        mfaEnabled: u.mfa_enabled,
        phone: u.phone,
        createdAt: u.created_at,
        checks: u.checks,
        reports: u.reports,
        lastActivity: u.last_activity,
        isSelf: u.id === user.id,
      })),
      invites: invites.rows.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        fullName: i.full_name,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
        invitedByName: i.invited_by_name,
        expired: new Date(i.expires_at) <= new Date(),
      })),
    };
  });
}

/**
 * What one person has actually done, with the subject named.
 *
 * Restricted to company admins: a full list of the checks a colleague ran is a
 * different thing from knowing they ran fourteen.
 */
export async function getMemberActivity(user: AuthUser, memberId: string) {
  const companyId = requireCompanyAdmin(user);

  return withContext(ctxForUser(user), async (client) => {
    const member = await client.query<{ full_name: string; email: string }>(
      `SELECT full_name, email FROM company_users WHERE id = $1 AND company_id = $2`,
      [memberId, companyId]
    );
    if (!member.rows[0]) throw notFound("Team member not found");

    const checks = await client.query<{
      id: string;
      subject_name: string;
      status: string;
      result: string | null;
      created_at: string;
    }>(
      `SELECT v.id, s.full_name AS subject_name, v.status, v.result, v.created_at
         FROM verification_requests v
         JOIN subjects s ON s.id = v.subject_id
        WHERE v.company_id = $1 AND v.requested_by = $2
        ORDER BY v.created_at DESC LIMIT 50`,
      [companyId, memberId]
    );

    const reports = await client.query<{
      id: string;
      subject_name: string;
      status: string;
      created_at: string;
      category_name: string;
    }>(
      `SELECT r.id, s.full_name AS subject_name, r.status, r.created_at,
              rc.name AS category_name
         FROM conduct_reports r
         JOIN subjects s ON s.id = r.subject_id
         JOIN report_categories rc ON rc.id = r.category_id
        WHERE r.submitted_by_company_id = $1 AND r.submitted_by_user_id = $2
        ORDER BY r.created_at DESC LIMIT 50`,
      [companyId, memberId]
    );

    return {
      member: { id: memberId, fullName: member.rows[0].full_name, email: member.rows[0].email },
      checks: checks.rows.map((c) => ({
        id: c.id,
        subjectName: c.subject_name,
        status: c.status,
        result: c.result,
        createdAt: c.created_at,
      })),
      reports: reports.rows.map((r) => ({
        id: r.id,
        subjectName: r.subject_name,
        categoryName: r.category_name,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });
}

// --- Invitations ---------------------------------------------------------------

export interface InviteInput {
  email: string;
  role: "company_admin" | "company_user";
  fullName?: string;
  ip?: string | null;
}

/**
 * Invite a colleague.
 *
 * The raw token is returned exactly once, here. There is no email transport
 * yet, so the admin copies the link and sends it themselves — which is honest
 * about what the platform does rather than pretending a message went out. When
 * a mail channel exists it sends this same link.
 */
export async function inviteMember(user: AuthUser, input: InviteInput) {
  const companyId = requireCompanyAdmin(user);
  const email = input.email.trim().toLowerCase();

  return withContext(ctxForUser(user), async (client) => {
    // A company must be verified before it can grow: an unverified applicant
    // handing out logins is how a fake company builds a plausible staff list.
    const company = await client.query<{ status: string; legal_name: string }>(
      `SELECT status, legal_name FROM companies WHERE id = $1`,
      [companyId]
    );
    if (company.rows[0]?.status !== "verified") {
      throw forbidden("Your company must be verified before you can invite colleagues");
    }

    // Anywhere on the platform, not just this company — emails are globally
    // unique on company_users, so an invite that could never be accepted should
    // fail now with a clear reason rather than at accept time.
    const existing = await client.query<{ company_id: string }>(
      `SELECT company_id FROM company_users WHERE email = $1`,
      [email]
    );
    if (existing.rows[0]) {
      throw conflict(
        existing.rows[0].company_id === companyId
          ? "That person already has access"
          : "That email address is already registered to another account"
      );
    }

    const token = randomBytes(32).toString("base64url");

    let created;
    try {
      created = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO company_user_invites
           (company_id, email, role, token_hash, invited_by, full_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
         RETURNING id, expires_at`,
        [
          companyId,
          email,
          input.role,
          hashToken(token),
          user.id,
          input.fullName?.trim() || null,
          INVITE_TTL_DAYS,
        ]
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("An invitation is already open for that email. Revoke it first to reissue.");
      }
      throw err;
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "team.invite_created",
      resourceType: "company_user_invite",
      resourceId: created.rows[0]!.id,
      metadata: { email, role: input.role },
      ipAddress: input.ip ?? null,
    });

    return {
      id: created.rows[0]!.id,
      email,
      role: input.role,
      expiresAt: created.rows[0]!.expires_at,
      // Shown once. Not stored anywhere in retrievable form.
      token,
      companyName: company.rows[0].legal_name,
    };
  });
}

export async function revokeInvite(user: AuthUser, inviteId: string, ip?: string | null) {
  const companyId = requireCompanyAdmin(user);

  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{ email: string }>(
      `UPDATE company_user_invites
          SET revoked_at = now()
        WHERE id = $1 AND company_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING email`,
      [inviteId, companyId]
    );
    if (!res.rows[0]) throw notFound("No open invitation with that id");

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "team.invite_revoked",
      resourceType: "company_user_invite",
      resourceId: inviteId,
      metadata: { email: res.rows[0].email },
      ipAddress: ip ?? null,
    });
    return { id: inviteId, revoked: true };
  });
}

/**
 * Public preview of an invitation, so the accept screen can say which company
 * is inviting you and to what address — before you type a password.
 *
 * Returns nothing identifying beyond that, and 404s on a bad or spent token,
 * so this cannot be used to probe whether an address is on the platform.
 */
export async function previewInvite(token: string) {
  return withContext(SYSTEM_CTX, async (client) => {
    const res = await client.query<{
      email: string;
      role: string;
      full_name: string | null;
      expires_at: string;
      legal_name: string;
    }>(
      `SELECT i.email, i.role, i.full_name, i.expires_at, c.legal_name
         FROM company_user_invites i
         JOIN companies c ON c.id = i.company_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > now()`,
      [hashToken(token)]
    );
    if (!res.rows[0]) throw notFound("This invitation is not valid or has expired");

    return {
      email: res.rows[0].email,
      role: res.rows[0].role,
      fullName: res.rows[0].full_name,
      companyName: res.rows[0].legal_name,
      expiresAt: res.rows[0].expires_at,
    };
  });
}

/**
 * Accept an invitation: create the account and consume the token.
 *
 * Runs as `system` because there is no session yet — the same path company
 * registration takes. `app.company_id` is pinned to the invite's company before
 * the insert so the company-scoped WITH CHECK policy is satisfied and the row
 * cannot land under a different company than the one that invited them.
 */
export async function acceptInvite(input: {
  token: string;
  fullName: string;
  password: string;
  ip?: string | null;
}) {
  const passwordHash = await hashPassword(input.password);

  return withContext(SYSTEM_CTX, async (client) => {
    // FOR UPDATE: two clicks on the accept button must not create two accounts.
    const invite = await client.query<{
      id: string;
      company_id: string;
      email: string;
      role: string;
    }>(
      `SELECT id, company_id, email, role
         FROM company_user_invites
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
        FOR UPDATE`,
      [hashToken(input.token)]
    );
    if (!invite.rows[0]) throw notFound("This invitation is not valid or has expired");
    const inv = invite.rows[0];

    await client.query("SELECT set_config('app.company_id', $1, true)", [inv.company_id]);

    let userId: string;
    try {
      const res = await client.query<{ id: string }>(
        `INSERT INTO company_users (company_id, full_name, email, role, password_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [inv.company_id, input.fullName.trim(), inv.email, inv.role, passwordHash]
      );
      userId = res.rows[0]!.id;
    } catch (err) {
      // Someone registered this address between the invite and the click.
      if (isUniqueViolation(err)) throw conflict("That email is already registered");
      throw err;
    }

    await client.query(
      `UPDATE company_user_invites
          SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`,
      [inv.id, userId]
    );

    await writeAudit(client, {
      actorId: userId,
      actorType: "user",
      action: "team.invite_accepted",
      resourceType: "company_user",
      resourceId: userId,
      metadata: { inviteId: inv.id, role: inv.role },
      ipAddress: input.ip ?? null,
    });

    // No tokens issued: they sign in normally. Accepting an invite and holding
    // a session are separate steps, and the login path is the one place that
    // checks account status and MFA.
    return { email: inv.email, role: inv.role };
  });
}

// --- Member administration -------------------------------------------------------

/**
 * Change a colleague's role, or deactivate/reactivate them.
 *
 * Two guards that matter: you cannot change your own role or status (an admin
 * demoting themselves by accident locks the company out of its own team page),
 * and the last active admin cannot be removed or demoted — a company with no
 * administrator can never invite anyone again without support intervention.
 */
export async function updateMember(
  user: AuthUser,
  memberId: string,
  input: { role?: "company_admin" | "company_user"; status?: "active" | "suspended"; ip?: string | null }
) {
  const companyId = requireCompanyAdmin(user);
  if (memberId === user.id) {
    throw badRequest("You cannot change your own role or access from this screen");
  }
  if (input.role === undefined && input.status === undefined) {
    throw badRequest("Nothing to change");
  }

  return withContext(ctxForUser(user), async (client) => {
    const before = await client.query<{ role: string; status: string; full_name: string }>(
      `SELECT role, status, full_name FROM company_users
        WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [memberId, companyId]
    );
    if (!before.rows[0]) throw notFound("Team member not found");

    const nextRole = input.role ?? before.rows[0].role;
    const nextStatus = input.status ?? before.rows[0].status;
    const wasActiveAdmin =
      before.rows[0].role === "company_admin" && before.rows[0].status === "active";
    const staysActiveAdmin = nextRole === "company_admin" && nextStatus === "active";

    if (wasActiveAdmin && !staysActiveAdmin) {
      const others = await client.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM company_users
          WHERE company_id = $1 AND role = 'company_admin' AND status = 'active' AND id <> $2`,
        [companyId, memberId]
      );
      if (Number(others.rows[0]?.count ?? 0) === 0) {
        throw conflict(
          "This is the only active administrator. Promote someone else first."
        );
      }
    }

    await client.query(`UPDATE company_users SET role = $2, status = $3 WHERE id = $1`, [
      memberId,
      nextRole,
      nextStatus,
    ]);

    // Deactivation has to bite immediately. Without this the person keeps
    // working until their refresh token lapses, which is precisely the window
    // that matters on the day someone is let go.
    if (nextStatus === "suspended") {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND user_type = 'company' AND revoked_at IS NULL`,
        [memberId]
      );
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "team.member_updated",
      resourceType: "company_user",
      resourceId: memberId,
      metadata: {
        from: { role: before.rows[0].role, status: before.rows[0].status },
        to: { role: nextRole, status: nextStatus },
      },
      ipAddress: input.ip ?? null,
    });

    return { id: memberId, role: nextRole, status: nextStatus };
  });
}

/**
 * Clear a colleague's MFA enrolment so they can set it up again.
 *
 * This is the lost-phone path, and it is genuinely a security downgrade for as
 * long as it lasts — so it is admin-only, loudly audited, and clears the secret
 * rather than revealing it. They re-enrol through the normal setup flow at next
 * login. Their sessions are cut at the same time: whoever has the old phone
 * should not keep a working session either.
 */
export async function resetMemberMfa(user: AuthUser, memberId: string, ip?: string | null) {
  const companyId = requireCompanyAdmin(user);

  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{ full_name: string; mfa_enabled: boolean }>(
      `UPDATE company_users
          SET mfa_secret = NULL, mfa_enabled = false
        WHERE id = $1 AND company_id = $2
        RETURNING full_name, mfa_enabled`,
      [memberId, companyId]
    );
    if (!res.rows[0]) throw notFound("Team member not found");

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND user_type = 'company' AND revoked_at IS NULL`,
      [memberId]
    );

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "team.mfa_reset",
      resourceType: "company_user",
      resourceId: memberId,
      ipAddress: ip ?? null,
    });

    return { id: memberId, mfaEnabled: false };
  });
}
