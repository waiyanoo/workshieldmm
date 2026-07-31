/**
 * Team management routes.
 *
 * Two of these are deliberately public: previewing and accepting an invitation
 * happen before the invitee has an account, so there is nothing to authenticate
 * with. The token itself is the authorisation, and both endpoints 404 on a bad
 * one so neither can be used to probe which addresses exist.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireTeamInvites } from "../../middleware/featureFlags";
import {
  acceptInvite,
  getMemberActivity,
  inviteMember,
  listTeam,
  previewInvite,
  resetMemberMfa,
  revokeInvite,
  updateMember,
} from "./team.service";

const inviteSchema = z
  .object({
    email: z.string().trim().email().max(255),
    role: z.enum(["company_admin", "company_user"]),
    fullName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const acceptSchema = z
  .object({
    token: z.string().min(20).max(200),
    fullName: z.string().trim().min(1).max(200),
    // Matches the registration policy — an invited account is a full account.
    password: z.string().min(12).max(200),
  })
  .strict();

const memberSchema = z
  .object({
    role: z.enum(["company_admin", "company_user"]).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .strict();

export const teamRouter = Router();

// --- Public invitation endpoints (no session exists yet) ------------------------

teamRouter.get(
  "/invites/:token",
  requireTeamInvites,
  asyncHandler(async (req, res) => {
    res.json(await previewInvite(req.params.token!));
  })
);

teamRouter.post(
  "/invites/accept",
  requireTeamInvites,
  validateBody(acceptSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await acceptInvite({ ...req.body, ip: req.ip }));
  })
);

// --- Everything below needs a company session ----------------------------------

teamRouter.use(requireAuth);
teamRouter.use(requireRole("company_admin", "company_user"));

// Who has access, what they have done, and which invitations are outstanding.
// Readable by any colleague: knowing who else can see your candidates' data is
// not privileged information within a company.
teamRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listTeam(req.user!));
  })
);

// One person's checks and reports, with subjects named. Admin-only.
teamRouter.get(
  "/members/:id/activity",
  asyncHandler(async (req, res) => {
    res.json(await getMemberActivity(req.user!, req.params.id!));
  })
);

teamRouter.post(
  "/invites",
  requireTeamInvites,
  validateBody(inviteSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await inviteMember(req.user!, { ...req.body, ip: req.ip }));
  })
);

// Revoking stays reachable with the flag off, so an invitation issued while it
// was on can still be withdrawn.
teamRouter.post(
  "/invites/:id/revoke",
  asyncHandler(async (req, res) => {
    res.json(await revokeInvite(req.user!, req.params.id!, req.ip));
  })
);

// Role change and deactivation/reactivation.
teamRouter.patch(
  "/members/:id",
  validateBody(memberSchema),
  asyncHandler(async (req, res) => {
    res.json(await updateMember(req.user!, req.params.id!, { ...req.body, ip: req.ip }));
  })
);

// Lost-phone recovery: clear MFA enrolment and cut their sessions.
teamRouter.post(
  "/members/:id/reset-mfa",
  asyncHandler(async (req, res) => {
    res.json(await resetMemberMfa(req.user!, req.params.id!, req.ip));
  })
);
