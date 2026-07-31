import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../../lib/asyncHandler";
import { badRequest } from "../../lib/errors";
import { validateBody } from "../../middleware/validate";
import { ctxFromReq, requireAuth, requireRole } from "../../middleware/auth";
import {
  COMPANY_DOCUMENT_TYPES,
  COMPANY_STATUSES,
  type CompanyDocumentType,
  type CompanyStatus,
} from "@hyper/shared";
import {
  getCompany,
  getCompanyDetail,
  listCompanies,
  registerCompany,
  setCompanyStatus,
  verifyCompany,
} from "./companies.service";
import {
  getDocumentDownloadUrl,
  listCompanyDocuments,
  reviewCompanyDocument,
  uploadCompanyDocument,
} from "./documents.service";
import {
  companyStatusSchema,
  registerCompanySchema,
  reviewDocumentSchema,
  verifyCompanySchema,
} from "./companies.schemas";

// Documents are proxied through the API (auth + hash + audit) rather than
// uploaded straight to storage. 10 MB cap; type validated in the service.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const companiesRouter = Router();

// Public employer registration → company created in `pending`. (§4)
companiesRouter.post(
  "/",
  validateBody(registerCompanySchema),
  asyncHandler(async (req, res) => {
    const result = await registerCompany({
      company: req.body.company,
      admin: req.body.admin,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json(result);
  })
);

// List companies (Super Admin), optionally filtered by status — powers the
// pending-verification queue.
companiesRouter.get(
  "/",
  requireAuth,
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.status === "string" ? req.query.status : undefined;
    const status =
      raw && (COMPANY_STATUSES as readonly string[]).includes(raw)
        ? (raw as CompanyStatus)
        : undefined;
    const items = await listCompanies(ctxFromReq(req), status);
    res.json({ items });
  })
);

// Confirm business registration against the DICA record. Super Admin only. (§4)
companiesRouter.post(
  "/:id/verify",
  requireAuth,
  requireRole("super_admin"),
  validateBody(verifyCompanySchema),
  asyncHandler(async (req, res) => {
    const company = await verifyCompany(req.params.id!, req.user!, {
      notes: req.body.notes,
      ip: req.ip,
    });
    res.json(company);
  })
);

// Suspend or reactivate a company. Suspension takes effect immediately: the
// Tier A and Tier B gates both require status 'verified'. Super Admin only.
companiesRouter.post(
  "/:id/status",
  requireAuth,
  requireRole("super_admin"),
  validateBody(companyStatusSchema),
  asyncHandler(async (req, res) => {
    const company = await setCompanyStatus(req.params.id!, req.user!, {
      status: req.body.status,
      reason: req.body.reason,
      ip: req.ip,
    });
    res.json(company);
  })
);

// Full company record for oversight: users, subscriptions, documents on file.
companiesRouter.get(
  "/:id/detail",
  requireAuth,
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    res.json(await getCompanyDetail(req.params.id!, req.user!));
  })
);

// Read a company (RLS: own company, or any for platform staff).
companiesRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const company = await getCompany(req.params.id!, ctxFromReq(req));
    res.json(company);
  })
);

// --- Verification documents -------------------------------------------------

// Upload a verification document (own company). PDF / JPEG / PNG, ≤10 MB.
companiesRouter.post(
  "/:id/documents",
  requireAuth,
  requireRole("company_admin", "company_user"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const docType = req.body?.docType as string | undefined;
    if (!docType || !(COMPANY_DOCUMENT_TYPES as readonly string[]).includes(docType)) {
      throw badRequest(`docType must be one of: ${COMPANY_DOCUMENT_TYPES.join(", ")}`);
    }
    if (!req.file) throw badRequest("A file is required");
    const doc = await uploadCompanyDocument(
      req.user!,
      req.params.id!,
      docType as CompanyDocumentType,
      { buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size },
      req.ip
    );
    res.status(201).json(doc);
  })
);

// List a company's documents (RLS: own company, or platform staff).
companiesRouter.get(
  "/:id/documents",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await listCompanyDocuments(req.params.id!, ctxFromReq(req));
    res.json({ items });
  })
);

// Approve or reject one document. Reviewers and Super Admins; a rejection must
// carry a reason, which is sent to the company as a notification.
companiesRouter.post(
  "/:id/documents/:docId/review",
  requireAuth,
  requireRole("admin_reviewer", "super_admin"),
  validateBody(reviewDocumentSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await reviewCompanyDocument(req.user!, req.params.id!, req.params.docId!, {
        decision: req.body.decision,
        reason: req.body.reason,
        ip: req.ip,
      })
    );
  })
);

// Get a short-lived download URL for one document (audited access).
companiesRouter.get(
  "/:id/documents/:docId/download",
  requireAuth,
  asyncHandler(async (req, res) => {
    const out = await getDocumentDownloadUrl(
      req.user!,
      req.params.id!,
      req.params.docId!,
      ctxFromReq(req),
      req.ip
    );
    res.json(out);
  })
);
