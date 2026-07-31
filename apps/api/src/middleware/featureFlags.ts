/**
 * Feature-flag guards.
 *
 * Tier B (conduct reports) must be unreachable unless explicitly enabled. This
 * guard is applied to every Tier B router so the endpoints return 403 in any
 * environment where FEATURE_TIER_B_ENABLED is false — the default everywhere
 * until the Phase 0 legal opinion is complete. (§7, concept §11)
 *
 * Deliberately role-blind: it never looks at the request, so no account —
 * Super Admin included — can reach Tier B while the flag is off. It is a
 * deployment kill switch for a feature with unresolved legal exposure, not a
 * permission that privileged users outrank.
 */
import type { RequestHandler } from "express";
import { env } from "../config/env";
import { featureDisabled } from "../lib/errors";

export const requireTierB: RequestHandler = (_req, _res, next) => {
  if (!env.FEATURE_TIER_B_ENABLED) {
    next(featureDisabled("Tier B (conduct reports) is not enabled in this environment"));
    return;
  }
  next();
};

/**
 * Team invitations.
 *
 * Same shape as the Tier B guard and for a related reason: an invitation
 * creates a login, and until the platform can deliver one itself the flow rests
 * on an administrator forwarding a credential by hand. Role-blind, so the whole
 * feature is either present or absent in a deployment.
 */
export const requireTeamInvites: RequestHandler = (_req, _res, next) => {
  if (!env.FEATURE_TEAM_INVITES_ENABLED) {
    next(featureDisabled("Team invitations are not enabled in this environment"));
    return;
  }
  next();
};
