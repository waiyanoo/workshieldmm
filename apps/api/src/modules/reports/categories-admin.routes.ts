import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import {
  createReportCategory,
  listAllReportCategories,
  updateReportCategory,
} from "./categories-admin.service";

const policyText = (min: number, max: number) => z.string().trim().min(min).max(max);
const reason = policyText(3, 500);

const createSchema = z
  .object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{2,79}$/),
    name: policyText(3, 160),
    description: policyText(3, 1_000),
    evidenceRequirements: policyText(3, 1_000),
    eligible: z.boolean(),
    reason,
  })
  .strict();

const updateSchema = z
  .object({
    name: policyText(3, 160).optional(),
    description: policyText(3, 1_000).optional(),
    evidenceRequirements: policyText(3, 1_000).optional(),
    eligible: z.boolean().optional(),
    reason,
  })
  .strict();

/** Policy changes are deliberately Super Admin-only and never delete a
 * category: reports must retain the category they were filed under. */
export const categoriesAdminRouter = Router();
categoriesAdminRouter.use(requireAuth);
categoriesAdminRouter.use(requireRole("super_admin"));

categoriesAdminRouter.get(
  "/report-categories",
  asyncHandler(async (req, res) => {
    res.json({ items: await listAllReportCategories(req.user!) });
  })
);

categoriesAdminRouter.post(
  "/report-categories",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createReportCategory(req.user!, { ...req.body, ip: req.ip }));
  })
);

categoriesAdminRouter.patch(
  "/report-categories/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json(await updateReportCategory(req.user!, req.params.id!, { ...req.body, ip: req.ip }));
  })
);
