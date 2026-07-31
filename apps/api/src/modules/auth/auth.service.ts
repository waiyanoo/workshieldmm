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
import { badRequest, mfaRequired, mfaSetupRequired, notFound, unauthorized } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";
import { verifyPassword } from "./password";
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
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

async function findUserByEmail(client: PoolClient, email: string): Promise<UserRow | null> {
  const company = await client.query<UserRow>(
    `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
            company_id, 'company'::text AS user_type
       FROM company_users WHERE email = $1`,
    [email]
  );
  if (company.rows[0]) return company.rows[0];

  const platform = await client.query<UserRow>(
    `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
            NULL::uuid AS company_id, 'platform'::text AS user_type
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
              company_id, 'company'::text AS user_type
         FROM company_users WHERE id = $1`,
      [id]
    );
    return r.rows[0] ?? null;
  }
  const r = await client.query<UserRow>(
    `SELECT id, email, role, password_hash, mfa_enabled, mfa_secret, status,
            NULL::uuid AS company_id, 'platform'::text AS user_type
       FROM platform_users WHERE id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

/** Minimal shape needed to mint a session. */
export interface SessionUser {
  id: string;
  user_type: "company" | "platform";
  role: Role;
  company_id: string | null;
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

    // MFA is mandatory for privileged roles.
    if (mfaRequiredFor(user.role) && !user.mfa_enabled) throw mfaSetupRequired();
    if (user.mfa_enabled) {
      if (!input.mfaCode) throw mfaRequired();
      if (!user.mfa_secret || !verifyMfaCode(input.mfaCode, user.mfa_secret)) {
        throw unauthorized("Invalid MFA code");
      }
    }

    const tokens = await issueTokens(client, user, input.ip, input.userAgent);
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

    // Rotate: mint a new token, revoke the old one and link them.
    const tokens = await issueTokens(client, user, input.ip, input.userAgent);
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

export async function startMfaSetup(user: AuthUser) {
  const secret = generateMfaSecret();
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{ email: string }>(
      `UPDATE ${userTable(user.userType)} SET mfa_secret = $1 WHERE id = $2 RETURNING email`,
      [secret, user.id]
    );
    if (!res.rows[0]) throw notFound("User not found");
    return { secret, otpauthUrl: mfaKeyUri(res.rows[0].email, secret) };
  });
}

export async function confirmMfa(user: AuthUser, code: string) {
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
    return { enabled: true };
  });
}
