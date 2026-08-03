/**
 * Authentication service. All flows run inside a transaction so the auth event
 * and its audit entry commit together. Login/refresh use a 'system' RLS context
 * (there is no tenant session yet); the company_users_system policy scopes what
 * that context can read.
 */
import type { PoolClient } from "pg";
import type { Role } from "@hyper/shared";
import { mfaRequiredFor } from "@hyper/shared";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, mfaRequired, notFound, unauthorized } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";
import { hashPassword, verifyPassword } from "./password";
import { toDataURL } from "qrcode";
import { generateMfaSecret, mfaKeyUri, verifyMfaCode } from "./mfa";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
  signAccessToken,
} from "./tokens";

const SYSTEM_CTX: AppContext = { userType: "system" };

interface UserRow {
  id: string;
  email: string;
  role: Role;
  password_hash: string;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  status: string;
  company_id: string | null;
  user_type: "company" | "platform";
  must_change_password?: boolean;
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

async function findUserByEmail(client: PoolClient, email: string): Promise<UserRow | null> {
  const company = await client.query<UserRow>(
    `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
            must_change_password, company_id, 'company'::text AS user_type
       FROM company_users WHERE email = $1`,
    [email]
  );
  if (company.rows[0]) return company.rows[0];

  const platform = await client.query<UserRow>(
    `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
            must_change_password, NULL::uuid AS company_id, 'platform'::text AS user_type
       FROM platform_users WHERE email = $1`,
    [email]
  );
  return platform.rows[0] ?? null;
}

async function loadUserById(
  client: PoolClient,
  id: string,
  userType: "company" | "platform"
): Promise<UserRow | null> {
  if (userType === "company") {
    const r = await client.query<UserRow>(
      `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
              must_change_password, company_id, 'company'::text AS user_type
         FROM company_users WHERE id = $1`,
      [id]
    );
    return r.rows[0] ?? null;
  }
  const r = await client.query<UserRow>(
    `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
            must_change_password, NULL::uuid AS company_id, 'platform'::text AS user_type
       FROM platform_users WHERE id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

/**
 * What a session is still missing, derived from the row every time.
 *
 * `must_change_password` is a column; "MFA not enrolled yet" is not — it is
 * role plus mfa_enabled. Deriving it in one place is what stops a token minted
 * somewhere else (refresh, change-password) from quietly dropping the
 * restriction and handing out unrestricted access.
 */
function sessionFlags(user: UserRow) {
  return {
    must_change_password: user.must_change_password === true,
    mfa_setup_required: mfaRequiredFor(user.role) && !user.mfa_enabled,
  };
}

/** Minimal shape needed to mint a session. */
export interface SessionUser {
  id: string;
  user_type: "company" | "platform";
  role: Role;
  company_id: string | null;
  /** Carried into the access token so the middleware can close every route. */
  must_change_password?: boolean;
  /** Same, for an account that still has to enrol a second factor. */
  mfa_setup_required?: boolean;
}

export async function issueTokens(
  client: PoolClient,
  user: SessionUser,
  ip?: string | null,
  userAgent?: string | null
): Promise<{ accessToken: string; refreshToken: string; refreshTokenId: string }> {
  const accessToken = signAccessToken({
    sub: user.id,
    userType: user.user_type,
    role: user.role,
    companyId: user.company_id ?? undefined,
    ...(user.must_change_password ? { mustChangePassword: true as const } : {}),
    ...(user.mfa_setup_required ? { mfaSetupRequired: true as const } : {}),
  });
  const { token, hash } = generateRefreshToken();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, user_type, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [user.id, user.user_type, hash, refreshExpiryDate(), userAgent ?? null, ip ?? null]
  );
  return { accessToken, refreshToken: token, refreshTokenId: inserted.rows[0]!.id };
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    role: user.role,
    userType: user.user_type,
    companyId: user.company_id,
  };
}

export interface LoginInput {
  email: string;
  password: string;
  mfaCode?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function login(input: LoginInput) {
  return withContext(SYSTEM_CTX, async (client) => {
    const user = await findUserByEmail(client, input.email);
    // Uniform failure to avoid leaking which emails exist.
    if (!user) throw unauthorized("Invalid credentials");
    if (user.status !== "active") throw unauthorized("Account is not active");

    const ok = await verifyPassword(user.password_hash, input.password);
    if (!ok) throw unauthorized("Invalid credentials");

    // MFA is mandatory for privileged roles. Rather than refuse the login —
    // which left the account with no way to enrol, because enrolment needs a
    // session — issue one that can reach enrolment and nothing else.
    const needsMfaSetup = mfaRequiredFor(user.role) && !user.mfa_enabled;
    if (user.mfa_enabled) {
      if (!input.mfaCode) throw mfaRequired();
      if (!user.mfa_secret || !verifyMfaCode(input.mfaCode, user.mfa_secret)) {
        throw unauthorized("Invalid MFA code");
      }
    }

    const tokens = await issueTokens(
      client,
      { ...user, ...sessionFlags(user) },
      input.ip,
      input.userAgent
    );
    await writeAudit(client, {
      actorId: user.id,
      actorType: user.user_type === "platform" ? "admin" : "user",
      action: "auth.login",
      resourceType: user.user_type === "platform" ? "platform_user" : "company_user",
      resourceId: user.id,
      ipAddress: input.ip ?? null,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: publicUser(user),
      // The client shows the matching screen on these; the API enforces both
      // regardless of what the client does.
      mustChangePassword: user.must_change_password === true,
      mfaSetupRequired: needsMfaSetup,
    };
  });
}

export async function refresh(input: {
  refreshToken: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const hash = hashRefreshToken(input.refreshToken);
  return withContext(SYSTEM_CTX, async (client) => {
    const res = await client.query(
      `SELECT id, user_id, user_type, revoked_at, expires_at
         FROM refresh_tokens WHERE token_hash = $1`,
      [hash]
    );
    const row = res.rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
      throw unauthorized("Invalid refresh token");
    }

    const user = await loadUserById(client, row.user_id, row.user_type);
    if (!user || user.status !== "active") throw unauthorized("Account is not active");

    // Rotate: mint a new token, revoke the old one and link them. The
    // restrictions are re-derived, not inherited — refreshing must not be a way
    // to shed them.
    const tokens = await issueTokens(
      client,
      { ...user, ...sessionFlags(user) },
      input.ip,
      input.userAgent
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
      [row.id, tokens.refreshTokenId]
    );

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  });
}

export async function logout(refreshToken: string): Promise<void> {
  const hash = hashRefreshToken(refreshToken);
  await withContext(SYSTEM_CTX, async (client) => {
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hash]
    );
  });
}

const userTable = (t: "company" | "platform") =>
  t === "platform" ? "platform_users" : "company_users";

/**
 * Replace your own password.
 *
 * The current password is required even when the account is on an
 * administrator-issued temporary one — they were given it, so they can type
 * it, and requiring it stops a hijacked session from locking the real owner
 * out.
 *
 * Every other session is revoked. If the reason for changing is "someone else
 * knows this password", leaving their session alive defeats the exercise. The
 * caller gets a fresh pair back so they are not signed out of the tab they are
 * standing in.
 */
export async function changeOwnPassword(
  user: AuthUser,
  input: { currentPassword: string; newPassword: string; ip?: string | null; userAgent?: string | null }
) {
  if (input.currentPassword === input.newPassword) {
    throw badRequest("The new password must be different from the current one");
  }

  // The CALLER's context, not `system`. company_users carries RLS scoped to
  // `company_id = app_company_id()`, and `system` satisfies neither that nor
  // app_is_platform() — so under SYSTEM_CTX this UPDATE matched zero rows,
  // silently, and the old password kept working after a "successful" change.
  const ctx: AppContext = {
    userType: user.userType,
    userId: user.id,
    companyId: user.companyId,
  };

  return withContext(ctx, async (client) => {
    const row = await loadUserById(client, user.id, user.userType);
    if (!row || row.status !== "active") throw unauthorized("Account is not active");
    if (!(await verifyPassword(row.password_hash, input.currentPassword))) {
      throw unauthorized("Current password is incorrect");
    }

    const table = userTable(user.userType);
    const updated = await client.query(
      `UPDATE ${table} SET password_hash = $2, must_change_password = false WHERE id = $1`,
      [user.id, await hashPassword(input.newPassword)]
    );
    // Never report success on a write RLS quietly dropped.
    if (updated.rowCount !== 1) throw unauthorized("Could not update this account");
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND user_type = $2 AND revoked_at IS NULL`,
      [user.id, user.userType]
    );

    const tokens = await issueTokens(
      client,
      { ...row, ...sessionFlags(row), must_change_password: false },
      input.ip,
      input.userAgent
    );
    await writeAudit(client, {
      actorId: user.id,
      actorType: user.userType === "platform" ? "admin" : "user",
      action: "auth.password_changed",
      resourceType: user.userType === "platform" ? "platform_user" : "company_user",
      resourceId: user.id,
      ipAddress: input.ip ?? null,
    });

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  });
}

/**
 * Begin enrolment, idempotently.
 *
 * The secret is issued once and then re-served until enrolment finishes. That
 * matters more than it looks: this endpoint is called whenever the setup page
 * opens, and a page opens more than once — a reload, a re-render, React's
 * double-invoked effects in development, two concurrent requests whose replies
 * arrive out of order. Minting a fresh secret each time silently invalidates
 * the QR the user has already scanned, so every code their authenticator
 * produces is rejected and there is no way out of the screen.
 */
export async function startMfaSetup(user: AuthUser) {
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{
      email: string;
      mfa_secret: string | null;
      mfa_enabled: boolean;
    }>(
      `SELECT email, mfa_secret, mfa_enabled FROM ${userTable(user.userType)} WHERE id = $1`,
      [user.id]
    );
    const row = res.rows[0];
    if (!row) throw notFound("User not found");
    // Re-enrolling an account that already has a working second factor would
    // replace the secret in its authenticator app with one nobody has scanned,
    // locking the account out. Clearing it is an administrator action.
    if (row.mfa_enabled) throw conflict("Two-step sign-in is already set up for this account");

    const secret = row.mfa_secret ?? generateMfaSecret();
    if (!row.mfa_secret) {
      await client.query(`UPDATE ${userTable(user.userType)} SET mfa_secret = $1 WHERE id = $2`, [
        secret,
        user.id,
      ]);
    }

    const otpauthUrl = mfaKeyUri(row.email, secret);
    // Rendered server-side so the browser needs no QR library, and so this
    // works on a machine with no internet access — which a platform operator's
    // workstation may well be.
    const qrDataUrl = await toDataURL(otpauthUrl, { margin: 1, width: 220 });
    return { secret, otpauthUrl, qrDataUrl };
  });
}

export async function confirmMfa(
  user: AuthUser,
  code: string,
  meta?: { ip?: string | null; userAgent?: string | null }
) {
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{ mfa_secret: string | null }>(
      `SELECT mfa_secret FROM ${userTable(user.userType)} WHERE id = $1`,
      [user.id]
    );
    const secret = res.rows[0]?.mfa_secret;
    if (!secret) throw badRequest("Start MFA setup first");
    if (!verifyMfaCode(code, secret)) throw badRequest("Invalid MFA code");

    await client.query(
      `UPDATE ${userTable(user.userType)} SET mfa_enabled = true WHERE id = $1`,
      [user.id]
    );
    await writeAudit(client, {
      actorId: user.id,
      actorType: user.userType === "platform" ? "admin" : "user",
      action: "auth.mfa_enabled",
      resourceType: userTable(user.userType),
      resourceId: user.id,
    });

    // A fresh pair without the enrolment restriction, so finishing setup does
    // not require signing in again with a code the app has only just started
    // generating.
    const row = await loadUserById(client, user.id, user.userType);
    const tokens = row
      ? await issueTokens(
          client,
          { ...row, mfa_setup_required: false, must_change_password: row.must_change_password === true },
          meta?.ip,
          meta?.userAgent
        )
      : null;

    return {
      enabled: true,
      accessToken: tokens?.accessToken,
      refreshToken: tokens?.refreshToken,
    };
  });
}
