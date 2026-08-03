/**
 * Promotion administration. Super Admin only — this sets what every company
 * pays, which is not a reviewer's decision to make.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  createPromotion,
  endPromotion,
  listPromotions,
  updatePromotion,
} from "./promotions.service";

const isoDate = z.string().datetime({ offset: true });

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // The database allows 1-99; the API refuses the top of that range because a
    // 90%-off subscription is far more likely to be a typo than an offer.
    percentOff: z.number().int().min(1).max(60),
    startsAt: isoDate,
    endsAt: isoDate,
  })
  .strict();

const updateSchema = createSchema.partial().strict();

export const promotionsRouter = Router();
promotionsRouter.use(requireAuth);
promotionsRouter.use(requireRole("super_admin"));

promotionsRouter.get(
  "/promotions",
  asyncHandler(async (req, res) => {
    res.json(await listPromotions(req.user!));
  })
);

promotionsRouter.post(
  "/promotions",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createPromotion(req.user!, { ...req.body, ip: req.ip }));
  })
);

promotionsRouter.patch(
  "/promotions/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json(await updatePromotion(req.user!, req.params.id!, { ...req.body, ip: req.ip }));
  })
);

/** Stop offering it. Not a delete: receipts still refer to it. */
promotionsRouter.post(
  "/promotions/:id/end",
  asyncHandler(async (req, res) => {
    res.json(await endPromotion(req.user!, req.params.id!, req.ip));
  })
);
