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
import {
  forbidden,
  mfaSetupRequired,
  passwordChangeRequired,
  unauthorized,
} from "../lib/errors";
import { verifyAccessToken } from "../modules/auth/tokens";

/** The only routes reachable while a temporary password is outstanding. */
const PASSWORD_CHANGE_PATHS = new Set(["/change-password", "/logout"]);

/** The only routes reachable while a required second factor is not enrolled. */
const MFA_SETUP_PATHS = new Set(["/mfa/setup", "/mfa/verify", "/logout"]);

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
      mustChangePassword: claims.mustChangePassword === true,
      mfaSetupRequired: claims.mfaSetupRequired === true,
    };

    // A temporary password issued by an administrator is good for exactly one
    // thing: replacing itself. Enforced here rather than per-route, so a new
    // endpoint cannot accidentally be reachable with a credential somebody
    // else has also seen.
    // One gate at a time, password first: a credential somebody else has seen
    // is the more urgent of the two. Checking both together closed
    // /change-password behind the MFA gate and deadlocked all over again.
    if (claims.mustChangePassword) {
      if (!PASSWORD_CHANGE_PATHS.has(req.path)) {
        next(passwordChangeRequired());
        return;
      }
    } else if (claims.mfaSetupRequired && !MFA_SETUP_PATHS.has(req.path)) {
      next(mfaSetupRequired());
      return;
    }
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
