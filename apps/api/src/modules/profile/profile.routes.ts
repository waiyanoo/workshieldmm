/**
 * Profile routes. Not behind requireTierB — every company has a profile
 * regardless of which tiers are enabled.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getProfile, updateCompanyProfile, updateOwnProfile } from "./profile.service";

/**
 * Permissive on purpose. Myanmar numbers get written 09xxxxxxxxx, +959xxxxxxxx,
 * with spaces or dashes, and rejecting a real number a customer typed is worse
 * than storing one with odd punctuation. Length and character class only.
 */
const phone = z
  .string()
  .trim()
  .regex(/^[+0-9][0-9\s().-]{4,24}$/, "Enter a valid phone number")
  .nullable()
  .optional();

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const companyProfileSchema = z
  .object({
    phone,
    contactEmail: z.string().trim().email().nullable().optional(),
    addressLine: optionalText(300),
    township: optionalText(100),
    city: optionalText(100),
    region: optionalText(100),
  })
  // Everything not listed is rejected rather than ignored, so an attempt to
  // slip `legalName` or `status` through this endpoint fails loudly.
  .strict();

const ownProfileSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    phone,
  })
  .strict();

export const profileRouter = Router();
profileRouter.use(requireAuth);
profileRouter.use(requireRole("company_admin", "company_user"));

// Company + your own details, plus who else has access.
profileRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getProfile(req.user!));
  })
);

// Company contact details. Admin-only; enforced again in the service.
profileRouter.patch(
  "/company",
  validateBody(companyProfileSchema),
  asyncHandler(async (req, res) => {
    res.json(await updateCompanyProfile(req.user!, { ...req.body, ip: req.ip }));
  })
);

// Your own name and phone.
profileRouter.patch(
  "/me",
  validateBody(ownProfileSchema),
  asyncHandler(async (req, res) => {
    res.json(await updateOwnProfile(req.user!, { ...req.body, ip: req.ip }));
  })
);
