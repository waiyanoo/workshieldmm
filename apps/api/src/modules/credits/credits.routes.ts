/**
 * Credit balance and history for the paying company, plus plan management for
 * Super Admins. (Pricing Plan §3, §4)
 *
 * Not behind requireTierB: credits meter Tier A searches too, so a company on a
 * deployment with Tier B off still needs to see its balance.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { forbidden } from "../../lib/errors";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import { withContext } from "../../db/pool";
import { getCreditSummary } from "./credits.service";
import { setCompanyPlan, topUpCredits } from "./plans.service";

export const creditsRouter = Router();

// A company's own balance, what is about to expire, and recent movements.
creditsRouter.get(
  "/",
  requireAuth,
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    if (!req.user!.companyId) throw forbidden("A company context is required");
    const summary = await withContext(
      { userType: req.user!.userType, userId: req.user!.id, companyId: req.user!.companyId },
      (client) => getCreditSummary(client, req.user!.companyId!)
    );
    res.json(summary);
  })
);

const planSchema = z.object({
  plan: z.enum(["free", "starter", "growth", "enterprise"]),
  // Enterprise credit allowances are negotiated per contract. (§3)
  monthlyCreditOverride: z.number().int().min(0).max(100_000).nullable().optional(),
  reason: z.string().min(1).max(500),
});

const topUpSchema = z.object({
  amount: z.number().int().min(1).max(100_000),
  reason: z.string().min(1).max(500),
});

export const creditsAdminRouter = Router();
creditsAdminRouter.use(requireAuth);

// Move a company between plans. Super Admin only — this is billing.
creditsAdminRouter.post(
  "/companies/:id/plan",
  requireRole("super_admin"),
  validateBody(planSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await setCompanyPlan(req.user!, req.params.id!, {
        plan: req.body.plan,
        monthlyCreditOverride: req.body.monthlyCreditOverride ?? null,
        reason: req.body.reason,
        ip: req.ip,
      })
    );
  })
);

// Credit top-up ("Buy credits", §3). Recorded as a purchase lot. There is no
// payment integration yet — a Super Admin grants credits after settlement is
// confirmed out of band (KBZPay / WavePay / bank transfer, §1).
creditsAdminRouter.post(
  "/companies/:id/credits",
  requireRole("super_admin"),
  validateBody(topUpSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await topUpCredits(req.user!, req.params.id!, {
        amount: req.body.amount,
        reason: req.body.reason,
        ip: req.ip,
      })
    );
  })
);
