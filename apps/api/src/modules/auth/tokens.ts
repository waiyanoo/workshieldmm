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
