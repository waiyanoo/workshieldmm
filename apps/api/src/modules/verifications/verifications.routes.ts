import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { ctxFromReq, requireAuth, requireRole } from "../../middleware/auth";
import { verificationLimiter } from "../../middleware/rateLimit";
import { createVerification, getVerification, listVerifications } from "./verifications.service";
import { respondToInfoRequest } from "../admin/queue.service";
import { createVerificationSchema } from "./verifications.schemas";

export const verificationsRouter = Router();

// Submit a Tier A verification check. Verified employer users only, and
// per-company rate limited. (§4, §5)
verificationsRouter.post(
  "/",
  requireAuth,
  requireRole("company_admin", "company_user"),
  verificationLimiter,
  validateBody(createVerificationSchema),
  asyncHandler(async (req, res) => {
    const result = await createVerification(req.user!, {
      subject: req.body.subject,
      authorization: req.body.authorization,
      ip: req.ip,
    });
    res.status(201).json(result);
  })
);

// List the caller's verification checks (RLS-scoped).
verificationsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const results = await listVerifications(ctxFromReq(req));
    res.json({ items: results });
  })
);

// Answer a reviewer's question, which puts the check back in the queue. The
// other half of POST /admin/verifications/:id/request-info.
verificationsRouter.post(
  "/:id/respond",
  requireAuth,
  requireRole("company_admin", "company_user"),
  validateBody(z.object({ answer: z.string().min(1).max(2000) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await respondToInfoRequest(req.user!, req.params.id!, req.body.answer, req.ip));
  })
);

// Retrieve a check result (RLS: own request only). (§4)
verificationsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await getVerification(req.params.id!, ctxFromReq(req));
    res.json(result);
  })
);
