/**
 * Authentication + RBAC middleware.
 *
 * requireAuth verifies the access token and attaches req.user. requireRole is
 * the first (API-layer) access-control check; PostgreSQL RLS is the second
 * layer behind it. ctxFromReq maps the principal onto the RLS session context.
 */
import type { RequestHandler } from "express";
import type { Role } from "@hyper/shared";
import type { AppContext } from "../db/pool";
import { forbidden, unauthorized } from "../lib/errors";
import { verifyAccessToken } from "../modules/auth/tokens";

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(unauthorized());
    return;
  }
  try {
    const claims = verifyAccessToken(header.slice("Bearer ".length));
    req.user = {
      id: claims.sub,
      userType: claims.userType,
      role: claims.role,
      companyId: claims.companyId,
    };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(forbidden());
      return;
    }
    next();
  };
}

/** Build the RLS session context from the authenticated principal. */
export function ctxFromReq(req: { user?: { id: string; userType: "company" | "platform"; companyId?: string } }): AppContext {
  const u = req.user;
  if (!u) throw unauthorized();
  return { userType: u.userType, userId: u.id, companyId: u.companyId };
}
