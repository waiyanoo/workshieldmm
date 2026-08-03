/**
 * Token issuance.
 *
 * Access tokens: short-lived JWTs carrying the minimum claims needed for RBAC
 * and RLS context. Refresh tokens: opaque random strings; only their SHA-256
 * hash is persisted (refresh_tokens.token_hash), and they are rotated on every
 * use so a stolen refresh token is single-use at best. (§2 Auth)
 */
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Role } from "@hyper/shared";
import { env } from "../../config/env";

export interface AccessClaims {
  sub: string;
  userType: "company" | "platform";
  role: Role;
  companyId?: string;
  /**
   * The holder is on an admin-issued temporary password and must replace it.
   *
   * Carried in the token rather than read from the database on every request:
   * the claim can only go stale in the SAFE direction. Changing the password
   * mints fresh tokens immediately, so nobody is left locked out — while a
   * token minted before the change keeps its restriction until it expires,
   * which is exactly what we want from a credential the admin also saw.
   */
  mustChangePassword?: true;
  /**
   * The account holds a role that requires MFA and has not enrolled yet.
   *
   * Refusing the login outright was the obvious thing and it deadlocked:
   * enrolment needs a session, and there was no way to get one. So the session
   * is issued but can reach nothing except setting up the second factor.
   */
  mfaSetupRequired?: true;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL });
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function refreshExpiryDate(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);
}
