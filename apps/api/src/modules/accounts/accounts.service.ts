/**
 * Account administration.
 *
 * This is the most dangerous surface in the product. A platform account can
 * read every company's candidates, their NRCs and their conduct reports, and a
 * company account can be taken over by whoever controls its login email. So the
 * rules here are tighter than convenience would suggest:
 *
 *   - THE ADMIN NEVER CHOOSES A PASSWORD. The system generates a one-time
 *     password and shows it once. Letting an admin type one means the admin
 *     knows a working credential for somebody else's account indefinitely.
 *   - EVERY ISSUED PASSWORD IS TEMPORARY. `must_change_password` closes every
 *     route but change-password until the holder replaces it, so the window in
 *     which two people know the password is as short as the holder's next login.
 *   - RESETS AND EMAIL CHANGES REVOKE SESSIONS. Both are used precisely when
 *     someone should stop having access; leaving a live session behind makes
 *     the action cosmetic.
 *   - NOTHING HERE IS SELF-SERVICE. You cannot reset your own password, change
 *     your own email, or alter your own role through these endpoints — an
 *     account takeover should not be able to entrench itself, and there is a
 *     normal change-password flow for your own credentials.
 *
 * Everything is audited. `audit.read` already logs who reads the trail; this
 * logs who changes who can read it.
 */
import { randomInt } from "node:crypto";
import { PLATFORM_ROLES, type PlatformRole } from "@hyper/shared";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { isUniqueViolation } from "../../lib/dbErrors";
import { hashPassword } from "../auth/password";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/**
 * A temporary password that survives being read aloud down a phone line.
 *
 * No 0/O, 1/l/I — a password that has to be dictated and then retyped is
 * mis-keyed far more often than it is guessed, and the recipient replaces it
 * within minutes anyway. Entropy is still ~62 bits over the 4 groups.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function temporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join("-");
}

// --- Platform staff --------------------------------------------------------

export interface AccountQuery {
  q?: string;
  limit: number;
  offset: number;
}

export async function listPlatformAccounts(admin: AuthUser, query: AccountQuery) {
  return withContext(ctxForUser(admin), async (client) => {
    const total = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform_users u
        WHERE ($1::text IS NULL
               OR u.email ILIKE '%' || $1 || '%'
               OR u.full_name ILIKE '%' || $1 || '%')`,
      [query.q?.trim() || null]
    );

    const res = await client.query<{
      id: string;
      full_name: string;
      email: string;
      role: string;
      status: string;
      mfa_enabled: boolean;
      must_change_password: boolean;
      created_at: string;
      created_by_name: string | null;
      decisions: number;
      last_login: string | null;
    }>(
      `SELECT u.id, u.full_name, u.email, u.role, u.status, u.mfa_enabled,
              u.must_change_password, u.created_at,
              c.full_name AS created_by_name,
              COALESCE(d.n, 0)::int AS decisions,
              l.last_login
         FROM platform_users u
         LEFT JOIN platform_users c ON c.id = u.created_by
         LEFT JOIN (
           SELECT assigned_to AS uid, count(*) AS n
             FROM verification_requests
            WHERE decided_at IS NOT NULL AND assigned_to IS NOT NULL
            GROUP BY assigned_to
         ) d ON d.uid = u.id
         LEFT JOIN (
           SELECT actor_id AS uid, max("timestamp") AS last_login
             FROM audit.audit_logs
            WHERE action = 'auth.login' AND actor_type = 'admin'
            GROUP BY actor_id
         ) l ON l.uid = u.id
        WHERE ($1::text IS NULL
               OR u.email ILIKE '%' || $1 || '%'
               OR u.full_name ILIKE '%' || $1 || '%')
        -- Paginated. Without a limit this returned every staff account ever
        -- created, and a page rendering a few thousand rows of buttons and
        -- tooltips locks the browser up long before the query is the problem.
        ORDER BY u.status, u.created_at
        LIMIT $2 OFFSET $3`,
      [query.q?.trim() || null, query.limit, query.offset]
    );

    return {
      total: total.rows[0]?.n ?? 0,
      items: res.rows.map((u) => ({
      id: u.id,
      fullName: u.full_name,
      email: u.email,
      role: u.role,
      status: u.status,
      mfaEnabled: u.mfa_enabled,
      mustChangePassword: u.must_change_password,
      createdAt: u.created_at,
      createdByName: u.created_by_name,
      decisions: u.decisions,
      lastLogin: u.last_login,
      isSelf: u.id === admin.id,
      })),
    };
  });
}

export async function createPlatformAccount(
  admin: AuthUser,
  input: { fullName: string; email: string; role: PlatformRole; ip?: string | null }
) {
  if (!(PLATFORM_ROLES as readonly string[]).includes(input.role)) {
    throw badRequest(`role must be one of: ${PLATFORM_ROLES.join(", ")}`);
  }
  const email = input.email.trim().toLowerCase();
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  return withContext(ctxForUser(admin), async (client) => {
    // Emails are unique per table, but a person holding both a staff and a
    // company login is a conflict of interest the concept forbids outright:
    // platform reviewers are never affiliated with a subscribing employer.
    const asCompany = await client.query(`SELECT 1 FROM company_users WHERE email = $1`, [email]);
    if (asCompany.rowCount) {
      throw conflict(
        "That email already belongs to a company account. Platform reviewers must not be affiliated with an employer."
      );
    }

    let created;
    try {
      created = await client.query<{ id: string }>(
        `INSERT INTO platform_users
           (full_name, email, role, password_hash, must_change_password, created_by)
         VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
        [input.fullName.trim(), email, input.role, passwordHash, admin.id]
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("That email already has a platform account");
      throw err;
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "account.platform_created",
      resourceType: "platform_user",
      resourceId: created.rows[0]!.id,
      metadata: { email, role: input.role },
      ipAddress: input.ip ?? null,
    });

    return {
      id: created.rows[0]!.id,
      email,
      role: input.role,
      // Shown once, never stored in retrievable form. MFA enrolment is forced
      // at first login by mfaRequiredFor(), so they set both before working.
      temporaryPassword: password,
    };
  });
}

export async function updatePlatformAccount(
  admin: AuthUser,
  id: string,
  input: {
    fullName?: string;
    email?: string;
    role?: PlatformRole;
    status?: "active" | "suspended";
    ip?: string | null;
  }
) {
  if (id === admin.id) {
    throw badRequest("You cannot change your own account from this screen");
  }
  if (
    input.fullName === undefined &&
    input.email === undefined &&
    input.role === undefined &&
    input.status === undefined
  ) {
    throw badRequest("Nothing to change");
  }

  return withContext(ctxForUser(admin), async (client) => {
    const before = await client.query<{
      full_name: string;
      email: string;
      role: string;
      status: string;
    }>(`SELECT full_name, email, role, status FROM platform_users WHERE id = $1 FOR UPDATE`, [id]);
    if (!before.rows[0]) throw notFound("Account not found");

    const nextRole = input.role ?? before.rows[0].role;
    const nextStatus = input.status ?? before.rows[0].status;
    const wasActiveSuper =
      before.rows[0].role === "super_admin" && before.rows[0].status === "active";
    if (wasActiveSuper && !(nextRole === "super_admin" && nextStatus === "active")) {
      const others = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM platform_users
          WHERE role = 'super_admin' AND status = 'active' AND id <> $1`,
        [id]
      );
      if ((others.rows[0]?.count ?? 0) === 0) {
        throw conflict("This is the only active Super Admin. Promote someone else first.");
      }
    }

    const email = input.email?.trim().toLowerCase();
    if (email && email !== before.rows[0].email.toLowerCase()) {
      const asCompany = await client.query(`SELECT 1 FROM company_users WHERE email = $1`, [email]);
      if (asCompany.rowCount) throw conflict("That email already belongs to a company account");
    }

    try {
      await client.query(
        `UPDATE platform_users
            SET full_name = COALESCE($2, full_name),
                email     = COALESCE($3, email),
                role      = $4,
                status    = $5
          WHERE id = $1`,
        [id, input.fullName?.trim() ?? null, email ?? null, nextRole, nextStatus]
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("That email is already in use");
      throw err;
    }

    // The login email IS the credential. Changing it, or closing the account,
    // has to end the sessions that were opened under the old one.
    const cutSessions = Boolean(email) || nextStatus === "suspended";
    if (cutSessions) {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND user_type = 'platform' AND revoked_at IS NULL`,
        [id]
      );
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "account.platform_updated",
      resourceType: "platform_user",
      resourceId: id,
      // The old and new email are both recorded: an email change is the classic
      // takeover route, and the trail is useless without the "from".
      metadata: {
        from: { email: before.rows[0].email, role: before.rows[0].role, status: before.rows[0].status },
        to: { email: email ?? before.rows[0].email, role: nextRole, status: nextStatus },
        sessionsRevoked: cutSessions,
      },
      ipAddress: input.ip ?? null,
    });

    return { id, role: nextRole, status: nextStatus, email: email ?? before.rows[0].email };
  });
}

// --- Password resets (both populations) -------------------------------------

async function resetPassword(
  admin: AuthUser,
  id: string,
  table: "platform_users" | "company_users",
  ip?: string | null
) {
  if (id === admin.id) {
    throw badRequest("Use the change-password screen for your own account");
  }
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);
  const userType = table === "platform_users" ? "platform" : "company";

  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ email: string; full_name: string }>(
      `UPDATE ${table}
          SET password_hash = $2, must_change_password = true
        WHERE id = $1
        RETURNING email, full_name`,
      [id, passwordHash]
    );
    if (!res.rows[0]) throw notFound("Account not found");

    // Everything else they had open dies with the old password.
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND user_type = $2 AND revoked_at IS NULL`,
      [id, userType]
    );

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "account.password_reset",
      resourceType: userType === "platform" ? "platform_user" : "company_user",
      resourceId: id,
      metadata: { email: res.rows[0].email },
      ipAddress: ip ?? null,
    });

    return {
      id,
      email: res.rows[0].email,
      fullName: res.rows[0].full_name,
      temporaryPassword: password,
    };
  });
}

export const resetPlatformPassword = (a: AuthUser, id: string, ip?: string | null) =>
  resetPassword(a, id, "platform_users", ip);
export const resetCompanyUserPassword = (a: AuthUser, id: string, ip?: string | null) =>
  resetPassword(a, id, "company_users", ip);

/** Clear an MFA enrolment so the holder can register a new device. */
export async function resetPlatformMfa(admin: AuthUser, id: string, ip?: string | null) {
  if (id === admin.id) throw badRequest("You cannot reset your own MFA from this screen");

  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ email: string }>(
      `UPDATE platform_users SET mfa_secret = NULL, mfa_enabled = false
        WHERE id = $1 RETURNING email`,
      [id]
    );
    if (!res.rows[0]) throw notFound("Account not found");
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND user_type = 'platform' AND revoked_at IS NULL`,
      [id]
    );
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "account.mfa_reset",
      resourceType: "platform_user",
      resourceId: id,
      metadata: { email: res.rows[0].email },
      ipAddress: ip ?? null,
    });
    // MFA is mandatory for these roles, so login pushes them straight back
    // into enrolment — the account is not left without a second factor.
    return { id, mfaEnabled: false };
  });
}

// --- Company accounts -------------------------------------------------------

export async function listCompanyAccounts(admin: AuthUser, query: AccountQuery) {
  return withContext(ctxForUser(admin), async (client) => {
    const total = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM company_users u JOIN companies c ON c.id = u.company_id
        WHERE ($1::text IS NULL
               OR u.email ILIKE '%' || $1 || '%'
               OR u.full_name ILIKE '%' || $1 || '%'
               OR c.legal_name ILIKE '%' || $1 || '%')`,
      [query.q?.trim() || null]
    );

    const res = await client.query<{
      id: string;
      full_name: string;
      email: string;
      role: string;
      status: string;
      mfa_enabled: boolean;
      must_change_password: boolean;
      created_at: string;
      company_id: string;
      company_name: string;
      company_status: string;
    }>(
      `SELECT u.id, u.full_name, u.email, u.role, u.status, u.mfa_enabled,
              u.must_change_password, u.created_at,
              c.id AS company_id, c.legal_name AS company_name, c.status AS company_status
         FROM company_users u
         JOIN companies c ON c.id = u.company_id
        WHERE ($1::text IS NULL
               OR u.email ILIKE '%' || $1 || '%'
               OR u.full_name ILIKE '%' || $1 || '%'
               OR c.legal_name ILIKE '%' || $1 || '%')
        ORDER BY c.legal_name, u.created_at
        LIMIT $2 OFFSET $3`,
      [query.q?.trim() || null, query.limit, query.offset]
    );

    return {
      total: total.rows[0]?.n ?? 0,
      items: res.rows.map((u) => ({
      id: u.id,
      fullName: u.full_name,
      email: u.email,
      role: u.role,
      status: u.status,
      mfaEnabled: u.mfa_enabled,
      mustChangePassword: u.must_change_password,
      createdAt: u.created_at,
      companyId: u.company_id,
      companyName: u.company_name,
      companyStatus: u.company_status,
      })),
    };
  });
}

export async function updateCompanyAccount(
  admin: AuthUser,
  id: string,
  input: { email?: string; status?: "active" | "suspended"; ip?: string | null }
) {
  if (input.email === undefined && input.status === undefined) {
    throw badRequest("Nothing to change");
  }
  const email = input.email?.trim().toLowerCase();

  return withContext(ctxForUser(admin), async (client) => {
    const before = await client.query<{ email: string; status: string; company_id: string; role: string }>(
      `SELECT email, status, company_id, role FROM company_users WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!before.rows[0]) throw notFound("Account not found");

    const nextStatus = input.status ?? before.rows[0].status;

    // Same rule the company's own team screen enforces: a company with no
    // active administrator can never invite anyone or fix its own details.
    if (
      before.rows[0].role === "company_admin" &&
      before.rows[0].status === "active" &&
      nextStatus === "suspended"
    ) {
      const others = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM company_users
          WHERE company_id = $1 AND role = 'company_admin' AND status = 'active' AND id <> $2`,
        [before.rows[0].company_id, id]
      );
      if ((others.rows[0]?.count ?? 0) === 0) {
        throw conflict("This is the company's only active administrator");
      }
    }

    if (email && email !== before.rows[0].email.toLowerCase()) {
      const asPlatform = await client.query(`SELECT 1 FROM platform_users WHERE email = $1`, [email]);
      if (asPlatform.rowCount) throw conflict("That email already belongs to a platform account");
    }

    try {
      await client.query(
        `UPDATE company_users SET email = COALESCE($2, email), status = $3 WHERE id = $1`,
        [id, email ?? null, nextStatus]
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("That email is already in use");
      throw err;
    }

    const cutSessions = Boolean(email) || nextStatus === "suspended";
    if (cutSessions) {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND user_type = 'company' AND revoked_at IS NULL`,
        [id]
      );
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "account.company_updated",
      resourceType: "company_user",
      resourceId: id,
      metadata: {
        from: { email: before.rows[0].email, status: before.rows[0].status },
        to: { email: email ?? before.rows[0].email, status: nextStatus },
        sessionsRevoked: cutSessions,
      },
      ipAddress: input.ip ?? null,
    });

    return { id, email: email ?? before.rows[0].email, status: nextStatus };
  });
}

/** Lost-phone recovery for a company user, from the platform side. */
export async function resetCompanyUserMfa(admin: AuthUser, id: string, ip?: string | null) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ email: string }>(
      `UPDATE company_users SET mfa_secret = NULL, mfa_enabled = false
        WHERE id = $1 RETURNING email`,
      [id]
    );
    if (!res.rows[0]) throw notFound("Account not found");
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND user_type = 'company' AND revoked_at IS NULL`,
      [id]
    );
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "account.mfa_reset",
      resourceType: "company_user",
      resourceId: id,
      metadata: { email: res.rows[0].email },
      ipAddress: ip ?? null,
    });
    return { id, mfaEnabled: false };
  });
}

export { forbidden };
