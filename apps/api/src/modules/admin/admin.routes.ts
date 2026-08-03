import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  decideVerification,
  getVerificationContext,
  readAuditLogs,
} from "./admin.service";
import {
  assignVerification,
  getQueueStats,
  listQueue,
  listReviewers,
  requestMoreInfo,
  setReviewerNote,
} from "./queue.service";
import { getPlatformStats } from "./stats.service";
import { getOperationalSummary } from "./operations.service";
import { grantSubscription } from "./subscriptions.service";

export const adminRouter = Router();

// All admin surfaces require a platform login.
adminRouter.use(requireAuth);

const decisionSchema = z.object({
  status: z.enum(["completed", "not_found"]),
  result: z.string().max(300).optional(),
  source: z.object({
    sourceCompany: z.string().trim().min(2).max(200),
    contactName: z.string().trim().min(2).max(200),
    contactDetails: z.string().trim().max(300).optional(),
    contactMethod: z.enum(["phone", "email", "letter", "portal", "in_person", "document", "other"]),
    response: z.enum(["employment_confirmed", "no_record", "unable_to_confirm"]),
    employmentStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    employmentEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    evidenceReference: z.string().trim().max(300).optional(),
    verifiedAt: z.string().datetime({ offset: true }).optional(),
  }),
});

const QUEUE_STATUSES = ["pending", "need_more_info", "completed", "not_found", "all"];

// The review queue. Filterable by status, by who holds the item, by a search
// across subject/NRC/company, and by age — the four questions a reviewer opens
// this screen to answer.
adminRouter.get(
  "/verifications",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    if (!QUEUE_STATUSES.includes(status)) {
      res.status(400).json({ error: { code: "bad_request", message: "Invalid status filter" } });
      return;
    }
    const assignment =
      typeof req.query.assignment === "string" && req.query.assignment ? req.query.assignment : "all";
    const olderThanHours = Number(req.query.olderThanHours);
    const items = await listQueue(req.user!, {
      status,
      assignment,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      olderThanHours: Number.isFinite(olderThanHours) && olderThanHours > 0 ? olderThanHours : undefined,
      limit: Math.min(Math.max(Number(req.query.limit) || 100, 1), 200),
    });
    res.json({ items });
  })
);

// Counts, backlog age, and turnaround. Powers the strip above the queue.
adminRouter.get(
  "/verifications-stats",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getQueueStats(req.user!));
  })
);

adminRouter.get(
  "/operations",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getOperationalSummary(req.user!));
  })
);

// Who can be assigned work, and how much each already holds.
adminRouter.get(
  "/reviewers",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json({ items: await listReviewers(req.user!) });
  })
);

// Claim, hand over, or release. `to: null` releases; `force` overrides another
// reviewer's claim, which is a deliberate second action rather than a default.
adminRouter.post(
  "/verifications/:id/assign",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(
    z.object({ to: z.string().uuid().nullable(), force: z.boolean().optional() }).strict()
  ),
  asyncHandler(async (req, res) => {
    res.json(
      await assignVerification(req.user!, req.params.id!, {
        to: req.body.to,
        force: req.body.force,
        ip: req.ip,
      })
    );
  })
);

// Internal working note. Not shown to the employer.
adminRouter.post(
  "/verifications/:id/note",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(z.object({ note: z.string().max(2000) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await setReviewerNote(req.user!, req.params.id!, req.body.note, req.ip));
  })
);

// Ask the employer a question; parks the check out of the pending queue.
adminRouter.post(
  "/verifications/:id/request-info",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(z.object({ question: z.string().min(1).max(1000) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await requestMoreInfo(req.user!, req.params.id!, req.body.question, req.ip));
  })
);

// What the platform already knows about the person a check names: identity,
// other companies' checks on the same NRC, and any published conduct reports.
adminRouter.get(
  "/verifications/:id/context",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getVerificationContext(req.user!, req.params.id!));
  })
);

// Complete a check: pending → completed | not_found, with a factual result.
adminRouter.post(
  "/verifications/:id/decision",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const out = await decideVerification(req.user!, req.params.id!, req.body, req.ip);
    res.json(out);
  })
);

const subscriptionSchema = z.object({
  tier: z.enum(["A", "B"]),
});

// Grant a subscription tier to a company (billing/entitlement provisioning —
// deliberately NOT behind the Tier B feature flag: entitlement can be set up
// ahead of the flag flip, and using Tier B still requires the flag).
adminRouter.post(
  "/companies/:id/subscriptions",
  requireRole("super_admin"),
  validateBody(subscriptionSchema),
  asyncHandler(async (req, res) => {
    const out = await grantSubscription(req.user!, req.params.id!, req.body.tier, req.ip);
    res.status(out.created ? 201 : 200).json(out);
  })
);

// Platform statistics: onboarding, credit consumption, and money in, over a
// period the caller chooses. Super Admin only — this is the commercial picture
// of the whole platform, not one company's own numbers.
//
// The period arrives as absolute instants computed in the VIEWER's timezone,
// with the offset alongside for bucketing. "This month" means their month.
adminRouter.get(
  "/stats",
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    const now = Date.now();
    const from = new Date(String(req.query.from ?? new Date(now - 30 * 86_400_000).toISOString()));
    const to = new Date(String(req.query.to ?? new Date(now).toISOString()));
    const raw = Number(req.query.tzOffsetMinutes);
    // Clamped to the range real offsets occupy (UTC-12 … UTC+14); a bad value
    // would shift every bucket rather than fail loudly.
    const tzOffsetMinutes =
      Number.isFinite(raw) && Math.abs(raw) <= 14 * 60 ? Math.trunc(raw) : 0;
    res.json(await getPlatformStats(req.user!, { from, to, tzOffsetMinutes }));
  })
);

// Read the audit trail. Super Admin only; the read is itself logged. (§4)
adminRouter.get(
  "/audit-logs",
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const action = typeof req.query.action === "string" && req.query.action ? req.query.action : undefined;
    const resourceType =
      typeof req.query.resourceType === "string" && req.query.resourceType
        ? req.query.resourceType
        : undefined;
    const items = await readAuditLogs(req.user!, { limit, offset, action, resourceType }, req.ip);
    res.json({ items, limit, offset });
  })
);
