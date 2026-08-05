/**
 * Credit purchase routes. (Pricing Plan §3, §7)
 *
 * Not behind requireTierB — credits meter Tier A searches too, so buying them
 * has to work wherever the platform runs.
 */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { badRequest } from "../../lib/errors";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  createPaymentIntent,
  createSubscriptionIntent,
  decidePayment,
  getPaymentProofUrl,
  listOwnPayments,
  listPaymentsForReview,
  listPurchaseOptions,
  submitPaymentProof,
  upsertPaymentMethod,
} from "./payments.service";
import { getReceipt } from "./receipts.service";

// Screenshots from a phone: 10 MB is generous for a photo, small enough that a
// misdirected upload cannot be used to fill the bucket.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// MMQR first: it is the Central Bank's unified standard, so one QR is
// scannable by every participating wallet. The per-wallet providers stay for
// the payments already reconciled under them. (0023)
const PROVIDERS = ["mmqr", "kbzpay", "wavepay", "bank_transfer"] as const;

const intentSchema = z.object({
  packageKey: z.string().min(1).max(100),
  provider: z.enum(PROVIDERS),
});

const subscriptionSchema = z.object({
  plan: z.enum(["starter", "growth", "enterprise"]),
  billingCycle: z.enum(["monthly", "annual"]),
  provider: z.enum(PROVIDERS),
});

const decisionSchema = z.object({
  decision: z.enum(["confirm", "reject"]),
  // Mandatory both ways: confirming moves money's worth of credits, rejecting
  // has to tell the buyer what went wrong.
  note: z.string().min(1).max(500),
});

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

// Packages, and the QR / account details to pay against.
paymentsRouter.get(
  "/options",
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    res.json(await listPurchaseOptions(req.user!));
  })
);

// Start a purchase: freezes the price and mints the reference code.
paymentsRouter.post(
  "/intents",
  requireRole("company_admin", "company_user"),
  validateBody(intentSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await createPaymentIntent(req.user!, {
        packageKey: req.body.packageKey,
        provider: req.body.provider,
        ip: req.ip,
      })
    );
  })
);

// Start a plan subscription payment. Same QR + reconciliation path.
paymentsRouter.post(
  "/subscriptions",
  requireRole("company_admin", "company_user"),
  validateBody(subscriptionSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await createSubscriptionIntent(req.user!, {
        plan: req.body.plan,
        billingCycle: req.body.billingCycle,
        provider: req.body.provider,
        ip: req.ip,
      })
    );
  })
);

// Declare payment made. Multipart: the wallet transaction id, plus an optional
// screenshot. Does not grant credits — an admin reconciles first.
paymentsRouter.post(
  "/intents/:id/proof",
  requireRole("company_admin", "company_user"),
  upload.single("proof"),
  asyncHandler(async (req, res) => {
    const payerReference = typeof req.body?.payerReference === "string"
      ? req.body.payerReference.trim()
      : "";
    if (payerReference.length < 3 || payerReference.length > 100) {
      throw badRequest("Enter the transaction number from your payment app");
    }
    res.json(
      await submitPaymentProof(req.user!, req.params.id!, {
        payerReference,
        payerNote: typeof req.body?.payerNote === "string" ? req.body.payerNote : undefined,
        proof: req.file
          ? { buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size }
          : undefined,
        ip: req.ip,
      })
    );
  })
);

paymentsRouter.get(
  "/",
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    res.json({ items: await listOwnPayments(req.user!) });
  })
);

// Receipt for a confirmed payment. Reviewers may fetch it too, so support can
// re-send one a customer has lost without asking them to log in and screenshot it.
paymentsRouter.get(
  "/:id/receipt",
  requireRole("company_admin", "company_user", "admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getReceipt(req.user!, req.params.id!));
  })
);

// --- Admin reconciliation --------------------------------------------------------

export const paymentsAdminRouter = Router();
paymentsAdminRouter.use(requireAuth);

paymentsAdminRouter.get(
  "/payments",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "submitted";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(await listPaymentsForReview(req.user!, { status, q, limit, offset }));
  })
);

paymentsAdminRouter.get(
  "/payments/:id/proof",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getPaymentProofUrl(req.user!, req.params.id!, req.ip));
  })
);

// Confirm (grants credits) or reject, after checking the wallet statement.
paymentsAdminRouter.post(
  "/payments/:id/decision",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await decidePayment(req.user!, req.params.id!, {
        decision: req.body.decision,
        note: req.body.note,
        ip: req.ip,
      })
    );
  })
);

// Set the QR image and account details buyers see. Super Admin only.
paymentsAdminRouter.post(
  "/payment-methods",
  requireRole("super_admin"),
  upload.single("qr"),
  asyncHandler(async (req, res) => {
    const provider = typeof req.body?.provider === "string" ? req.body.provider : "";
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      throw badRequest(`provider must be one of: ${PROVIDERS.join(", ")}`);
    }
    for (const field of ["displayName", "accountName", "accountNumber"]) {
      if (typeof req.body?.[field] !== "string" || !req.body[field].trim()) {
        throw badRequest(`${field} is required`);
      }
    }
    res.json(
      await upsertPaymentMethod(req.user!, {
        provider,
        displayName: req.body.displayName.trim(),
        accountName: req.body.accountName.trim(),
        accountNumber: req.body.accountNumber.trim(),
        instructions: typeof req.body.instructions === "string" ? req.body.instructions : undefined,
        active: req.body.active !== "false",
        qr: req.file
          ? { buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size }
          : undefined,
        ip: req.ip,
      })
    );
  })
);
