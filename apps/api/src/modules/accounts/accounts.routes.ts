/**
 * Account administration routes. Super Admin only, without exception.
 *
 * Reviewers deliberately cannot reach these: the ability to reset a password or
 * change a login email is the ability to become another user, and that is not a
 * power the review queue needs to do its job.
 */
import { Router } from "express";
import { z } from "zod";
import { PLATFORM_ROLES } from "@hyper/shared";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  createPlatformAccount,
  listCompanyAccounts,
  listPlatformAccounts,
  resetCompanyUserMfa,
  resetCompanyUserPassword,
  resetPlatformMfa,
  resetPlatformPassword,
  updateCompanyAccount,
  updatePlatformAccount,
} from "./accounts.service";

const email = z.string().trim().email().max(255);

// No password field anywhere in these schemas — deliberately. The system
// generates temporary passwords so an administrator never holds a working
// credential for somebody else's account.
const createSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email,
    role: z.enum(PLATFORM_ROLES as unknown as [string, ...string[]]),
  })
  .strict();

const updatePlatformSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    email: email.optional(),
    role: z.enum(PLATFORM_ROLES as unknown as [string, ...string[]]).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .strict();

const updateCompanySchema = z
  .object({
    email: email.optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .strict();

export const accountsRouter = Router();
accountsRouter.use(requireAuth);
accountsRouter.use(requireRole("super_admin"));

// --- Platform staff ----------------------------------------------------------

/** Shared paging + search, capped so one request cannot ask for everything. */
function accountQuery(req: { query: Record<string, unknown> }) {
  return {
    q: typeof req.query.q === "string" && req.query.q ? req.query.q : undefined,
    limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
    offset: Math.max(Number(req.query.offset) || 0, 0),
  };
}

accountsRouter.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    res.json(await listPlatformAccounts(req.user!, accountQuery(req)));
  })
);

// Returns the temporary password once. It is never retrievable again.
accountsRouter.post(
  "/accounts",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await createPlatformAccount(req.user!, {
        fullName: req.body.fullName,
        email: req.body.email,
        role: req.body.role,
        ip: req.ip,
      })
    );
  })
);

accountsRouter.patch(
  "/accounts/:id",
  validateBody(updatePlatformSchema),
  asyncHandler(async (req, res) => {
    res.json(await updatePlatformAccount(req.user!, req.params.id!, { ...req.body, ip: req.ip }));
  })
);

accountsRouter.post(
  "/accounts/:id/reset-password",
  asyncHandler(async (req, res) => {
    res.json(await resetPlatformPassword(req.user!, req.params.id!, req.ip));
  })
);

accountsRouter.post(
  "/accounts/:id/reset-mfa",
  asyncHandler(async (req, res) => {
    res.json(await resetPlatformMfa(req.user!, req.params.id!, req.ip));
  })
);

// --- Company accounts ---------------------------------------------------------

accountsRouter.get(
  "/company-accounts",
  asyncHandler(async (req, res) => {
    res.json(await listCompanyAccounts(req.user!, accountQuery(req)));
  })
);

accountsRouter.patch(
  "/company-accounts/:id",
  validateBody(updateCompanySchema),
  asyncHandler(async (req, res) => {
    res.json(await updateCompanyAccount(req.user!, req.params.id!, { ...req.body, ip: req.ip }));
  })
);

accountsRouter.post(
  "/company-accounts/:id/reset-password",
  asyncHandler(async (req, res) => {
    res.json(await resetCompanyUserPassword(req.user!, req.params.id!, req.ip));
  })
);

accountsRouter.post(
  "/company-accounts/:id/reset-mfa",
  asyncHandler(async (req, res) => {
    res.json(await resetCompanyUserMfa(req.user!, req.params.id!, req.ip));
  })
);
