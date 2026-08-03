/**
 * Tier B routers. ALL of these are mounted behind requireTierB in app.ts —
 * they return 403 feature_disabled in any environment where the flag is off,
 * which is the default everywhere. (§7)
 *
 * Direct-publish model: a reviewer's evidence-sufficient decision publishes the
 * report to other verified employers. No subject notice, no dispute stage — the
 * admin correction path (withdraw/correct) handles inaccuracies instead.
 */
import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../../lib/asyncHandler";
import { badRequest } from "../../lib/errors";
import { validateBody } from "../../middleware/validate";
import { ctxFromReq, requireAuth, requireRole } from "../../middleware/auth";
import { accessSearchLimiter, reportSubmissionLimiter } from "../../middleware/rateLimit";
import {
  attachEvidence,
  correctReport,
  createDraftReport,
  decideAccessRequest,
  decideReport,
  downloadEvidenceAsCompany,
  getEvidenceDownloadUrl,
  getEvidenceForCompany,
  getReportAsCompany,
  getReportForAdmin,
  listAccessRequestsForAdmin,
  listAllReports,
  listEligibleCategories,
  listOwnReports,
  listReportsForReview,
  requestAccess,
  submitReport,
  withdrawOwnReport,
  withdrawReport,
} from "./reports.service";
import {
  accessDecisionSchema,
  accessRequestSchema,
  correctSchema,
  createReportSchema,
  reportDecisionSchema,
  submitReportSchema,
  withdrawSchema,
} from "./reports.schemas";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const REPORT_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "expired",
  "withdrawn",
];

// --- /report-categories -------------------------------------------------------

export const categoriesRouter = Router();

categoriesRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await listEligibleCategories(ctxFromReq(req));
    res.json({ items });
  })
);

// --- /reports (employer) --------------------------------------------------------

export const reportsRouter = Router();

// Create a draft report. Verified employer with Tier B subscription. (§4)
reportsRouter.post(
  "/",
  requireAuth,
  requireRole("company_admin", "company_user"),
  reportSubmissionLimiter,
  validateBody(createReportSchema),
  asyncHandler(async (req, res) => {
    const report = await createDraftReport(req.user!, { ...req.body, ip: req.ip });
    res.status(201).json(report);
  })
);

// List own reports.
reportsRouter.get(
  "/",
  requireAuth,
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    res.json({ items: await listOwnReports(req.user!) });
  })
);

// Attach evidence (own report, draft state only). (§4)
reportsRouter.post(
  "/:id/evidence",
  requireAuth,
  requireRole("company_admin", "company_user"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("An evidence file is required");
    const out = await attachEvidence(
      req.user!,
      req.params.id!,
      { buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size },
      req.ip
    );
    res.status(201).json(out);
  })
);

// Submit for admin review. Evidence is mandatory. (§4, concept §3.2)
reportsRouter.post(
  "/:id/submit",
  requireAuth,
  requireRole("company_admin", "company_user"),
  validateBody(submitReportSchema),
  asyncHandler(async (req, res) => {
    res.json(await submitReport(req.user!, req.params.id!, req.body.declaration, req.ip));
  })
);

// Evidence pack for a report the company has access to (charged, §4).
reportsRouter.get(
  "/:id/evidence",
  requireAuth,
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    res.json(await getEvidenceForCompany(req.user!, req.params.id!, req.ip));
  })
);

// Download one evidence file (charged per file, §4).
reportsRouter.get(
  "/:id/evidence/:fileId/download",
  requireAuth,
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    res.json(
      await downloadEvidenceAsCompany(req.user!, req.params.id!, req.params.fileId!, req.ip)
    );
  })
);

// The filer retracts its own published report. Not admin-gated: this only
// removes a claim about a person. (§5 correction path)
reportsRouter.post(
  "/:id/withdraw",
  requireAuth,
  requireRole("company_admin", "company_user"),
  validateBody(withdrawSchema),
  asyncHandler(async (req, res) => {
    res.json(await withdrawOwnReport(req.user!, req.params.id!, req.body.reason, req.ip));
  })
);

// Read one report: own freely; another employer's via approved access request.
reportsRouter.get(
  "/:id",
  requireAuth,
  requireRole("company_admin", "company_user"),
  asyncHandler(async (req, res) => {
    res.json(await getReportAsCompany(req.user!, req.params.id!, req.ip));
  })
);

// --- /admin (report review + correction) ----------------------------------------

export const reportsAdminRouter = Router();
reportsAdminRouter.use(requireAuth);

// Queue of reports awaiting evidence review. (§4)
reportsAdminRouter.get(
  "/reports/pending",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json({ items: await listReportsForReview(req.user!) });
  })
);

// Super Admin oversight: all reports, metadata only, status-filtered. Not a
// bulk export — the list read is audited; content is opened one at a time. (§5)
reportsAdminRouter.get(
  "/reports",
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.status === "string" ? req.query.status : undefined;
    const status = raw && REPORT_STATUSES.includes(raw) ? raw : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(await listAllReports(req.user!, { status, limit, offset }, req.ip));
  })
);

// Pending access requests queue.
reportsAdminRouter.get(
  "/access-requests",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json({ items: await listAccessRequestsForAdmin(req.user!) });
  })
);

// Full report detail (report + evidence list) for review.
reportsAdminRouter.get(
  "/reports/:id/detail",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getReportForAdmin(req.user!, req.params.id!));
  })
);

// Audited evidence download for review.
reportsAdminRouter.get(
  "/reports/:id/evidence/:fileId/download",
  requireRole("admin_reviewer", "super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getEvidenceDownloadUrl(req.user!, req.params.id!, req.params.fileId!, req.ip));
  })
);

// Accept (publish) on sufficient evidence / reject on insufficient. (§4)
reportsAdminRouter.post(
  "/reports/:id/decision",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(reportDecisionSchema),
  asyncHandler(async (req, res) => {
    res.json(await decideReport(req.user!, req.params.id!, req.body, req.ip));
  })
);

// Correction path: withdraw or correct a published report. (accuracy safeguard)
reportsAdminRouter.post(
  "/reports/:id/withdraw",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(withdrawSchema),
  asyncHandler(async (req, res) => {
    res.json(await withdrawReport(req.user!, req.params.id!, req.body.reason, req.ip));
  })
);

reportsAdminRouter.post(
  "/reports/:id/correct",
  requireRole("admin_reviewer", "super_admin"),
  validateBody(correctSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await correctReport(
        req.user!,
        req.params.id!,
        req.body.narrativeSummary,
        req.body.reason,
        req.ip
      )
    );
  })
);

// --- /access-requests --------------------------------------------------------------

export const accessRequestsRouter = Router();

// Employer requests access to published reports for a subject. Rate-limited
// per company — this is the anti-bulk-scraping surface. (§4, §5)
accessRequestsRouter.post(
  "/",
  requireAuth,
  requireRole("company_admin", "company_user"),
  accessSearchLimiter,
  validateBody(accessRequestSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await requestAccess(req.user!, req.body, req.ip));
  })
);

// Approve/deny access. (§4)
accessRequestsRouter.post(
  "/:id/decision",
  requireAuth,
  requireRole("admin_reviewer", "super_admin"),
  validateBody(accessDecisionSchema),
  asyncHandler(async (req, res) => {
    res.json(await decideAccessRequest(req.user!, req.params.id!, req.body.status, req.ip));
  })
);
