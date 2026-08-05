/**
 * Tier B — evidence-gated conduct reports. (concept §3.2, tech doc §3/§4)
 *
 * Direct-publish model: reports are shared between subscribing companies and
 * accepted on strong, admin-verified evidence. A reviewer's evidence-sufficient
 * decision publishes the report — there is no pre-publication notice to the
 * reported person and no dispute stage. Accuracy rests on (a) the admin
 * evidence gate and (b) the correction path: a published report can be
 * corrected or withdrawn, audited with a reason.
 *
 * Lifecycle:
 *   draft → pending_review → approved | rejected → expired
 *   approved → withdrawn   (correction path; also corrected in place)
 *
 * Structural rules encoded here:
 *  - Only a VERIFIED employer may file. Filing is free and earns credits on
 *    acceptance; reading another employer's report is what costs. (Pricing §2)
 *  - Ineligible (protected-activity) categories are refused here AND by the
 *    data-layer trigger.
 *  - A report cannot be submitted without documentary evidence.
 *  - The submitting employer can never self-publish; only a reviewer or super
 *    admin can accept.
 *  - Cross-company reads happen ONLY through an approved access request, and
 *    every such read is audited.
 *
 * Every endpoint here is mounted behind requireTierB. (§7)
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import {
  badRequest,
  conflict,
  declarationOutdated,
  forbidden,
  notFound,
} from "../../lib/errors";
import { currentDeclarationVersion, normalizeNrc } from "@hyper/shared";
import { hashNationalId } from "../../lib/crypto";
import { REPORT_ACCEPTED_REWARD, grantCredits, spendCredits } from "../credits/credits.service";
import { presignGet, putObject } from "../../lib/storage";
import { env } from "../../config/env";
import type { AuthUser } from "../../types/auth";

const ALLOWED_EVIDENCE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

const SYSTEM_CTX: AppContext = { userType: "system" };

interface ReportRow {
  id: string;
  submitted_by_company_id: string;
  subject_id: string;
  category_id: string;
  status: string;
  narrative_summary: string | null;
  expiry_date: string | null;
  created_at: string;
}

function publicReport(r: ReportRow) {
  return {
    id: r.id,
    companyId: r.submitted_by_company_id,
    subjectId: r.subject_id,
    categoryId: r.category_id,
    status: r.status,
    narrativeSummary: r.narrative_summary,
    expiryDate: r.expiry_date,
    createdAt: r.created_at,
  };
}

/**
 * Gate shared by all Tier B write paths.
 *
 * Verified company only — that is a trust control and stays. There is no
 * subscription-tier check: under the pricing plan every registered company can
 * use every feature and plans differ only in bundled credits (Pricing Plan §1).
 * Submitting a report is free by design (§2), so nothing is charged here.
 */
async function requireTierBCompany(client: PoolClient, companyId: string): Promise<void> {
  const company = await client.query<{ status: string }>(
    `SELECT status FROM companies WHERE id = $1`,
    [companyId]
  );
  if (company.rows[0]?.status !== "verified") {
    throw forbidden("Company must be verified to use conduct reports");
  }
}

// --- Categories ---------------------------------------------------------------

export async function listEligibleCategories(ctx: AppContext) {
  return withContext(ctx, async (client) => {
    const res = await client.query<{
      id: string;
      key: string;
      name: string;
      description: string;
      evidence_requirements: string;
    }>(
      `SELECT id, key, name, description, evidence_requirements
         FROM report_categories WHERE eligible = true ORDER BY name`
    );
    return res.rows.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      description: c.description,
      evidenceRequirements: c.evidence_requirements,
    }));
  });
}

// --- Employer: draft / evidence / submit ---------------------------------------

export interface CreateReportInput {
  subject: { fullName: string; nationalId: string; dateOfBirth?: string };
  categoryKey: string;
  narrativeSummary: string;
  ip?: string | null;
}

export async function createDraftReport(user: AuthUser, input: CreateReportInput) {
  if (!user.companyId) throw forbidden("A company context is required");
  const nationalIdHash = hashNationalId(input.subject.nationalId);

  return withContext(ctxForUser(user), async (client) => {
    await requireTierBCompany(client, user.companyId!);

    const cat = await client.query<{ id: string; eligible: boolean }>(
      `SELECT id, eligible FROM report_categories WHERE key = $1`,
      [input.categoryKey]
    );
    if (!cat.rows[0]) throw badRequest("Unknown report category");
    if (!cat.rows[0].eligible) {
      // Friendly refusal here; the DB trigger enforces it regardless. (§3.2)
      throw badRequest("This category is excluded from adverse reporting by policy");
    }

    // Hash remains the matching key; the raw NRC is kept so reviewers can
    // confirm they are looking at the right person. (0012)
    const subject = await client.query<{ id: string }>(
      `INSERT INTO subjects (full_name, national_id_hash, national_id, date_of_birth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (national_id_hash) DO UPDATE
         SET updated_at  = now(),
             national_id = COALESCE(subjects.national_id, EXCLUDED.national_id)
       RETURNING id`,
      [
        input.subject.fullName,
        nationalIdHash,
        // Stored in the same canonical form it is hashed under, so what a
        // reviewer reads back matches what the matching keyed on.
        normalizeNrc(input.subject.nationalId),
        input.subject.dateOfBirth ?? null,
      ]
    );

    const created = await client.query<ReportRow>(
      // The person, not just the company. A report is an allegation about
      // someone's conduct; when one turns out to be wrong, "the company filed
      // it" is not an answer anybody can act on. (team.service.ts)
      `INSERT INTO conduct_reports
         (submitted_by_company_id, submitted_by_user_id, subject_id, category_id,
          status, narrative_summary)
       VALUES ($1, $2, $3, $4, 'draft', $5)
       RETURNING *`,
      [user.companyId, user.id, subject.rows[0]!.id, cat.rows[0].id, input.narrativeSummary]
    );
    const report = created.rows[0]!;

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.create",
      resourceType: "conduct_report",
      resourceId: report.id,
      metadata: { categoryKey: input.categoryKey },
      ipAddress: input.ip ?? null,
    });
    return publicReport(report);
  });
}

export interface EvidenceUpload {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export async function attachEvidence(
  user: AuthUser,
  reportId: string,
  file: EvidenceUpload,
  ip?: string | null
) {
  if (!ALLOWED_EVIDENCE_TYPES.has(file.mimetype)) {
    throw badRequest("Evidence must be a PDF, JPEG, or PNG");
  }

  return withContext(ctxForUser(user), async (client) => {
    const report = await client.query<{ status: string }>(
      `SELECT status FROM conduct_reports WHERE id = $1`,
      [reportId]
    );
    if (!report.rows[0]) throw notFound("Report not found");
    if (report.rows[0].status !== "draft") {
      throw conflict("Evidence can only be attached while the report is a draft"); // (§4)
    }

    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    const key = `evidence/${reportId}/${randomUUID()}`;
    await putObject(key, file.buffer, file.mimetype);

    const res = await client.query<{ id: string; uploaded_at: string }>(
      `INSERT INTO evidence_files
         (report_id, storage_ref, uploaded_by, file_hash, content_type, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, uploaded_at`,
      [reportId, key, user.id, fileHash, file.mimetype, file.size]
    );

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.evidence_upload",
      resourceType: "evidence_file",
      resourceId: res.rows[0]!.id,
      metadata: { reportId },
      ipAddress: ip ?? null,
    });
    return { id: res.rows[0]!.id, uploadedAt: res.rows[0]!.uploaded_at };
  });
}

/** Submit for review. Evidence is mandatory (concept §3.2 step 2). */
export async function submitReport(
  user: AuthUser,
  reportId: string,
  declaration: { accepted: true; version: string },
  ip?: string | null
) {
  // See registerCompany: the version accepted must be the version on offer.
  if (declaration.version !== currentDeclarationVersion("report_submission")) {
    throw declarationOutdated();
  }
  return withContext(ctxForUser(user), async (client) => {
    const evidence = await client.query(`SELECT 1 FROM evidence_files WHERE report_id = $1`, [
      reportId,
    ]);
    if (evidence.rowCount === 0) {
      throw badRequest("Documentary evidence is mandatory before submission");
    }

    const res = await client.query<ReportRow>(
      // `submitted_at`, not `created_at`, is the start of the review clock —
      // the draft may have sat with the employer for days. (0022)
      `UPDATE conduct_reports SET status = 'pending_review', submitted_at = now()
        WHERE id = $1 AND status = 'draft' RETURNING *`,
      [reportId]
    );
    if (!res.rows[0]) {
      const exists = await client.query(`SELECT status FROM conduct_reports WHERE id = $1`, [
        reportId,
      ]);
      if (!exists.rows[0]) throw notFound("Report not found");
      throw conflict(`Report is already ${exists.rows[0].status}`);
    }

    await client.query(
      `INSERT INTO company_declarations
         (company_id, company_user_id, conduct_report_id, kind, declaration_version)
       VALUES ($1, $2, $3, 'report_submission', $4)`,
      // See companies.service: the recorded version is the server's.
      [user.companyId, user.id, reportId, currentDeclarationVersion("report_submission")]
    );

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.submit",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { submissionDeclarationVersion: declaration.version },
      ipAddress: ip ?? null,
    });
    return publicReport(res.rows[0]);
  });
}

/**
 * The employer's own reports, each with the evidence attached to it. RLS scopes
 * this to the caller's company. The evidence list rides along because the
 * employer needs to see what they have uploaded before submitting — without it
 * an upload looks like it vanished.
 */
export async function listOwnReports(user: AuthUser) {
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<ReportRow>(
      `SELECT * FROM conduct_reports ORDER BY created_at DESC LIMIT 100`
    );
    if (res.rows.length === 0) return [];

    const evidence = await client.query<{
      id: string;
      report_id: string;
      content_type: string | null;
      byte_size: string | null;
      uploaded_at: string;
    }>(
      `SELECT id, report_id, content_type, byte_size, uploaded_at
         FROM evidence_files WHERE report_id = ANY($1::uuid[]) ORDER BY uploaded_at`,
      [res.rows.map((r) => r.id)]
    );

    const byReport = new Map<string, typeof evidence.rows>();
    for (const e of evidence.rows) {
      const list = byReport.get(e.report_id) ?? [];
      list.push(e);
      byReport.set(e.report_id, list);
    }

    return res.rows.map((r) => ({
      ...publicReport(r),
      evidence: (byReport.get(r.id) ?? []).map((e) => ({
        id: e.id,
        contentType: e.content_type,
        byteSize: e.byte_size === null ? null : Number(e.byte_size),
        uploadedAt: e.uploaded_at,
      })),
    }));
  });
}

// --- Admin review ---------------------------------------------------------------

/** The reviewer's evidence-sufficiency queue. (concept §3.2 step 3) */
export async function listReportsForReview(admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query(
      `SELECT r.id, r.status, r.narrative_summary, r.created_at,
              c.legal_name AS company_name,
              s.full_name  AS subject_name, s.date_of_birth, s.national_id,
              rc.name AS category_name, rc.evidence_requirements,
              (SELECT count(*) FROM evidence_files e WHERE e.report_id = r.id) AS evidence_count
         FROM conduct_reports r
         JOIN companies c  ON c.id  = r.submitted_by_company_id
         JOIN subjects  s  ON s.id  = r.subject_id
         JOIN report_categories rc ON rc.id = r.category_id
        WHERE r.status = 'pending_review'
        ORDER BY r.created_at
        LIMIT 100`
    );
    return res.rows.map((r) => ({
      id: r.id,
      status: r.status,
      narrativeSummary: r.narrative_summary,
      createdAt: r.created_at,
      companyName: r.company_name,
      subjectName: r.subject_name,
      subjectDateOfBirth: r.date_of_birth,
      subjectNationalId: r.national_id,
      categoryName: r.category_name,
      evidenceRequirements: r.evidence_requirements,
      evidenceCount: Number(r.evidence_count),
    }));
  });
}

/** Full report detail for a reviewer: report + evidence file list. */
export async function getReportForAdmin(admin: AuthUser, reportId: string) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query(
      `SELECT r.id, r.status, r.narrative_summary, r.created_at, r.expiry_date,
              rc.name AS category_name, rc.evidence_requirements,
              c.legal_name AS company_name,
              s.full_name AS subject_name, s.date_of_birth, s.national_id, s.created_at AS subject_since
         FROM conduct_reports r
         JOIN report_categories rc ON rc.id = r.category_id
         JOIN companies c ON c.id = r.submitted_by_company_id
         JOIN subjects  s ON s.id = r.subject_id
        WHERE r.id = $1`,
      [reportId]
    );
    if (!res.rows[0]) throw notFound("Report not found");
    const evidence = await client.query<{
      id: string;
      content_type: string | null;
      byte_size: string | null;
      uploaded_at: string;
    }>(
      `SELECT id, content_type, byte_size, uploaded_at
         FROM evidence_files WHERE report_id = $1 ORDER BY uploaded_at`,
      [reportId]
    );
    // Opening a report's content is a justified, logged access. (concept §4)
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report.detail_view",
      resourceType: "conduct_report",
      resourceId: reportId,
    });

    const r = res.rows[0];
    return {
      id: r.id,
      status: r.status,
      narrativeSummary: r.narrative_summary,
      createdAt: r.created_at,
      expiryDate: r.expiry_date,
      categoryName: r.category_name,
      evidenceRequirements: r.evidence_requirements,
      companyName: r.company_name,
      // Identifying fields on `subjects` are deliberately minimal (tech doc §3
      // data minimization): a name and an optional date of birth. The national
      // ID is stored only as a peppered HMAC, so it cannot be shown here — see
      // `national_id_hash` in 0001_init.sql.
      subjectName: r.subject_name,
      subjectDateOfBirth: r.date_of_birth,
      subjectNationalId: r.national_id,
      subjectSince: r.subject_since,
      evidence: evidence.rows.map((e) => ({
        id: e.id,
        contentType: e.content_type,
        byteSize: e.byte_size === null ? null : Number(e.byte_size),
        uploadedAt: e.uploaded_at,
      })),
    };
  });
}

/**
 * Super Admin oversight: all reports across companies, METADATA ONLY (no
 * narrative / no evidence) with a status filter + pagination. Deliberately not
 * a bulk export — content is read one report at a time via the audited detail
 * endpoint. The list read itself is audited so browsing is accountable. (§5)
 */
export interface OversightQuery {
  status?: string;
  limit: number;
  offset: number;
}

export async function listAllReports(admin: AuthUser, q: OversightQuery, ip?: string | null) {
  return withContext(ctxForUser(admin), async (client) => {
    const rows = await client.query(
      `SELECT r.id, r.status, r.created_at, r.expiry_date,
              rc.name AS category_name,
              c.legal_name AS company_name,
              s.full_name AS subject_name, s.date_of_birth, s.national_id,
              (SELECT count(*) FROM evidence_files e WHERE e.report_id = r.id) AS evidence_count
         FROM conduct_reports r
         JOIN report_categories rc ON rc.id = r.category_id
         JOIN companies c ON c.id = r.submitted_by_company_id
         JOIN subjects  s ON s.id = r.subject_id
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.limit, q.offset]
    );

    const counts = await client.query<{ status: string; count: string }>(
      `SELECT status, count(*)::int AS count FROM conduct_reports GROUP BY status`
    );

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report.oversight_list",
      resourceType: "conduct_report",
      metadata: {
        status: q.status ?? "all",
        limit: q.limit,
        offset: q.offset,
        returned: rows.rowCount,
      },
      ipAddress: ip ?? null,
    });

    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        status: r.status,
        categoryName: r.category_name,
        companyName: r.company_name,
        subjectName: r.subject_name,
        subjectDateOfBirth: r.date_of_birth,
        subjectNationalId: r.national_id,
        evidenceCount: Number(r.evidence_count),
        createdAt: r.created_at,
        expiryDate: r.expiry_date,
      })),
      counts: Object.fromEntries(counts.rows.map((c) => [c.status, Number(c.count)])),
    };
  });
}

/** Undecided review-board cases with the context a panel member needs. */
/** Pending access requests for the admin queue. */
export async function listAccessRequestsForAdmin(admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query(
      `SELECT ar.id, ar.status, ar.requested_at,
              c.legal_name AS requesting_company,
              s.full_name  AS subject_name,
              rc.name AS category_name,
              ar.report_id
         FROM access_requests ar
         JOIN companies c ON c.id = ar.requesting_company_id
         JOIN subjects  s ON s.id = ar.subject_id
         JOIN conduct_reports r ON r.id = ar.report_id
         JOIN report_categories rc ON rc.id = r.category_id
        WHERE ar.status = 'requested'
        ORDER BY ar.requested_at
        LIMIT 100`
    );
    return res.rows.map((row) => ({
      id: row.id,
      status: row.status,
      requestedAt: row.requested_at,
      requestingCompany: row.requesting_company,
      subjectName: row.subject_name,
      categoryName: row.category_name,
      reportId: row.report_id,
    }));
  });
}

export async function getEvidenceDownloadUrl(
  admin: AuthUser,
  reportId: string,
  fileId: string,
  ip?: string | null
) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ storage_ref: string }>(
      `SELECT storage_ref FROM evidence_files WHERE id = $1 AND report_id = $2`,
      [fileId, reportId]
    );
    if (!res.rows[0]) throw notFound("Evidence file not found");

    // Raw evidence access is always a logged, justified event. (concept §4)
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report.evidence_access",
      resourceType: "evidence_file",
      resourceId: fileId,
      metadata: { reportId },
      ipAddress: ip ?? null,
    });
    return { url: await presignGet(res.rows[0].storage_ref) };
  });
}

export async function decideReport(
  admin: AuthUser,
  reportId: string,
  input: { decision: "evidence_sufficient" | "evidence_insufficient"; notes?: string },
  ip?: string | null
) {
  return withContext(ctxForUser(admin), async (client) => {
    const report = await client.query<ReportRow>(
      `SELECT * FROM conduct_reports WHERE id = $1`,
      [reportId]
    );
    if (!report.rows[0]) throw notFound("Report not found");
    if (report.rows[0].status !== "pending_review") {
      throw conflict(`Report is ${report.rows[0].status}, not pending_review`);
    }

    await client.query(
      `INSERT INTO review_cases (report_id, reviewer_id, decision, notes, decided_at)
       VALUES ($1, $2, $3, $4, now())`,
      [reportId, admin.id, input.decision, input.notes ?? null]
    );

    if (input.decision === "evidence_insufficient") {
      const updated = await client.query<ReportRow>(
        `UPDATE conduct_reports SET status = 'rejected' WHERE id = $1 RETURNING *`,
        [reportId]
      );
      await writeAudit(client, {
        actorId: admin.id,
        actorType: "admin",
        action: "report.reject",
        resourceType: "conduct_report",
        resourceId: reportId,
        metadata: { reason: "evidence_insufficient" },
        ipAddress: ip ?? null,
      });
      return publicReport(updated.rows[0]!);
    }

    // Evidence sufficient publishes the report to other verified employers,
    // with an expiry stamped. The employer can never self-publish — only a
    // reviewer or super admin reaches this path — and the correction path below
    // handles inaccuracies after the fact.
    const updated = await client.query<ReportRow>(
      `UPDATE conduct_reports
          SET status = 'approved',
              expiry_date = now() + make_interval(years => $2)
        WHERE id = $1 RETURNING *`,
      [reportId, env.REPORT_EXPIRY_YEARS]
    );

    // Data-supply incentive: credits are awarded on ACCEPTANCE, never on
    // submission, so the reward tracks accuracy rather than volume.
    // (Pricing Plan §4 Credit Earning)
    await grantCredits(client, {
      companyId: updated.rows[0]!.submitted_by_company_id,
      amount: REPORT_ACCEPTED_REWARD,
      reason: "report_accepted",
      action: "earn.report_accepted",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { acceptedBy: admin.id },
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report.approve",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { basis: "evidence_sufficient", creditsAwarded: REPORT_ACCEPTED_REWARD },
      ipAddress: ip ?? null,
    });
    return publicReport(updated.rows[0]!);
  });
}

/**
 * Company-facing evidence access for a report it has been granted. Two metered
 * actions from the pricing plan land here: pulling the full evidence pack for
 * review (25 credits), and downloading one file (5 credits). Reviewer/admin
 * access is platform staff doing their job and is never charged.
 * (Pricing Plan §4)
 */
export async function getEvidenceForCompany(user: AuthUser, reportId: string, ip?: string | null) {
  if (!user.companyId) throw forbidden("A company context is required");

  const grant = await withContext(ctxForUser(user), async (client) => {
    const own = await client.query(
      `SELECT 1 FROM conduct_reports WHERE id = $1 AND submitted_by_company_id = $2`,
      [reportId, user.companyId]
    );
    if (own.rowCount) return "own";
    const res = await client.query(
      `SELECT 1 FROM access_requests
        WHERE requesting_company_id = $1 AND report_id = $2 AND status = 'approved' LIMIT 1`,
      [user.companyId, reportId]
    );
    return res.rowCount ? "granted" : null;
  });
  if (!grant) throw forbidden("Access to this report has not been granted");

  // Own evidence is free to review; charging to read your own filing would turn
  // supplying records into a cost rather than an incentive.
  if (grant === "granted") {
    await withContext(ctxForUser(user), async (client) => {
      await spendCredits(client, {
        companyId: user.companyId!,
        action: "evidence.review",
        resourceType: "conduct_report",
        resourceId: reportId,
        actorUserId: user.id,
      });
    });
  }

  return withContext(SYSTEM_CTX, async (client) => {
    const files = await client.query<{
      id: string;
      content_type: string | null;
      uploaded_at: string;
    }>(
      `SELECT id, content_type, uploaded_at FROM evidence_files
        WHERE report_id = $1 ORDER BY uploaded_at`,
      [reportId]
    );
    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.evidence_review",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { requestingCompanyId: user.companyId, charged: grant === "granted" },
      ipAddress: ip ?? null,
    });
    return {
      items: files.rows.map((f) => ({
        id: f.id,
        contentType: f.content_type,
        uploadedAt: f.uploaded_at,
      })),
    };
  });
}

/** Presigned download of one evidence file, charged per file. (§4) */
export async function downloadEvidenceAsCompany(
  user: AuthUser,
  reportId: string,
  fileId: string,
  ip?: string | null
) {
  if (!user.companyId) throw forbidden("A company context is required");

  const isOwn = await withContext(ctxForUser(user), async (client) => {
    const own = await client.query(
      `SELECT 1 FROM conduct_reports WHERE id = $1 AND submitted_by_company_id = $2`,
      [reportId, user.companyId]
    );
    if (own.rowCount) return true;
    const granted = await client.query(
      `SELECT 1 FROM access_requests
        WHERE requesting_company_id = $1 AND report_id = $2 AND status = 'approved' LIMIT 1`,
      [user.companyId, reportId]
    );
    if (granted.rowCount === 0) throw forbidden("Access to this report has not been granted");
    return false;
  });

  if (!isOwn) {
    await withContext(ctxForUser(user), async (client) => {
      await spendCredits(client, {
        companyId: user.companyId!,
        action: "evidence.download",
        resourceType: "evidence_file",
        resourceId: fileId,
        actorUserId: user.id,
      });
    });
  }

  return withContext(SYSTEM_CTX, async (client) => {
    const res = await client.query<{ storage_ref: string }>(
      `SELECT storage_ref FROM evidence_files WHERE id = $1 AND report_id = $2`,
      [fileId, reportId]
    );
    if (!res.rows[0]) throw notFound("Evidence file not found");
    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.evidence_download",
      resourceType: "evidence_file",
      resourceId: fileId,
      metadata: { reportId, requestingCompanyId: user.companyId, charged: !isOwn },
      ipAddress: ip ?? null,
    });
    return { url: await presignGet(res.rows[0].storage_ref) };
  });
}

/**
 * The submitting employer retracts its own published report.
 *
 * Deliberately available to the filer without going through an admin: this only
 * ever removes a claim about a person, so the failure mode of allowing it is
 * mild and the failure mode of blocking it — a company that knows its report is
 * wrong having to wait on a queue — is not.
 *
 * The +10 acceptance reward is reversed, otherwise the loop "file, get
 * accepted, collect credits, withdraw, repeat" mints credits for records that
 * no longer exist — the credit-farming risk the pricing plan flags in §7. The
 * reversal never blocks the withdrawal: if the balance has already been spent
 * we claw back what is there and record the shortfall. Retracting a false claim
 * about someone must not depend on the filer's ability to pay it back.
 */
export async function withdrawOwnReport(
  user: AuthUser,
  reportId: string,
  reason: string,
  ip?: string | null
) {
  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    // RLS already scopes this to the caller's company; the explicit predicate
    // documents the intent and survives a policy change.
    const res = await client.query<ReportRow>(
      `UPDATE conduct_reports SET status = 'withdrawn'
        WHERE id = $1 AND submitted_by_company_id = $2 AND status = 'approved'
        RETURNING *`,
      [reportId, user.companyId]
    );
    if (!res.rows[0]) {
      const exists = await client.query<{ status: string }>(
        `SELECT status FROM conduct_reports WHERE id = $1`,
        [reportId]
      );
      if (!exists.rows[0]) throw notFound("Report not found");
      throw conflict(
        `Only a published report can be withdrawn (this one is ${exists.rows[0].status})`
      );
    }

    // Reverse the acceptance reward, to whatever extent the balance allows.
    const reward = await client.query<{ lot_id: string | null }>(
      `SELECT lot_id FROM credit_ledger
        WHERE company_id = $1 AND resource_id = $2 AND action = 'earn.report_accepted'
        LIMIT 1`,
      [user.companyId, reportId]
    );
    let clawedBack = 0;
    if (reward.rows[0]) {
      const lots = await client.query<{ id: string; remaining: number }>(
        `SELECT id, remaining FROM credit_lots
          WHERE company_id = $1 AND remaining > 0 AND expires_at > now()
          ORDER BY expires_at DESC
          FOR UPDATE`,
        [user.companyId]
      );
      let outstanding = REPORT_ACCEPTED_REWARD;
      for (const lot of lots.rows) {
        if (outstanding === 0) break;
        const take = Math.min(lot.remaining, outstanding);
        await client.query(`UPDATE credit_lots SET remaining = remaining - $2 WHERE id = $1`, [
          lot.id,
          take,
        ]);
        outstanding -= take;
        clawedBack += take;
      }
      if (clawedBack > 0) {
        await client.query(
          `INSERT INTO credit_ledger
             (company_id, delta, action, resource_type, resource_id, actor_user_id, metadata)
           VALUES ($1, $2, 'reverse.report_withdrawn', 'conduct_report', $3, $4, $5)`,
          [
            user.companyId,
            -clawedBack,
            reportId,
            user.id,
            JSON.stringify({ reward: REPORT_ACCEPTED_REWARD, shortfall: outstanding }),
          ]
        );
      }
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.withdraw",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { reason, by: "submitting_company", creditsReversed: clawedBack },
      ipAddress: ip ?? null,
    });
    return { ...publicReport(res.rows[0]), creditsReversed: clawedBack };
  });
}

// --- Correction path (the accuracy safeguard for a published report) --------------

/**
 * Withdraw a published report — the enforceable end of the correction path. A
 * reported person who contacts the operator, or an admin who finds a report
 * inaccurate, can have it withdrawn: it leaves the `approved` state, so it is
 * no longer discoverable or readable via access requests. Audited with reason.
 */
export async function withdrawReport(
  admin: AuthUser,
  reportId: string,
  reason: string,
  ip?: string | null
) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<ReportRow>(
      `UPDATE conduct_reports SET status = 'withdrawn'
        WHERE id = $1 AND status = 'approved' RETURNING *`,
      [reportId]
    );
    if (!res.rows[0]) {
      const exists = await client.query(`SELECT status FROM conduct_reports WHERE id = $1`, [
        reportId,
      ]);
      if (!exists.rows[0]) throw notFound("Report not found");
      throw conflict(`Only a published report can be withdrawn (currently ${exists.rows[0].status})`);
    }
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report.withdraw",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { reason },
      ipAddress: ip ?? null,
    });
    return publicReport(res.rows[0]);
  });
}

/** Correct the factual summary of a published report (audited, reason-logged). */
export async function correctReport(
  admin: AuthUser,
  reportId: string,
  narrativeSummary: string,
  reason: string,
  ip?: string | null
) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<ReportRow>(
      `UPDATE conduct_reports SET narrative_summary = $2
        WHERE id = $1 AND status = 'approved' RETURNING *`,
      [reportId, narrativeSummary]
    );
    if (!res.rows[0]) {
      const exists = await client.query(`SELECT status FROM conduct_reports WHERE id = $1`, [
        reportId,
      ]);
      if (!exists.rows[0]) throw notFound("Report not found");
      throw conflict(`Only a published report can be corrected (currently ${exists.rows[0].status})`);
    }
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report.correct",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { reason },
      ipAddress: ip ?? null,
    });
    return publicReport(res.rows[0]);
  });
}

// --- Access requests (cross-company reads of published reports) ---------------------

export async function requestAccess(
  user: AuthUser,
  input: { subject: { nationalId: string } },
  ip?: string | null
) {
  if (!user.companyId) throw forbidden("A company context is required");
  const nationalIdHash = hashNationalId(input.subject.nationalId);

  // Step 1 (company ctx): entitlement gate + subject lookup.
  const subjectId = await withContext(ctxForUser(user), async (client) => {
    await requireTierBCompany(client, user.companyId!);
    const subject = await client.query<{ id: string }>(
      `SELECT id FROM subjects WHERE national_id_hash = $1`,
      [nationalIdHash]
    );
    return subject.rows[0]?.id ?? null;
  });
  if (!subjectId) return { items: [] }; // no such subject — nothing to request

  // Step 2 (system ctx): discover published, unexpired reports. Company-ctx
  // RLS would hide other employers' reports, so discovery is a service-
  // internal read. This is the rate-limited "search" surface (§5) — it
  // reveals report EXISTENCE only; content requires an approved request.
  const published = await withContext(SYSTEM_CTX, async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM conduct_reports
        WHERE subject_id = $1
          AND status = 'approved'
          AND (expiry_date IS NULL OR expiry_date > now())`,
      [subjectId]
    );
    return res.rows;
  });

  // Step 3 (company ctx): create the requests (deduped) + audit.
  return withContext(ctxForUser(user), async (client) => {
    const items: { reportId: string; accessRequestId: string; status: string }[] = [];
    for (const row of published) {
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM access_requests
          WHERE requesting_company_id = $1 AND report_id = $2
            AND status IN ('requested', 'approved')
          LIMIT 1`,
        [user.companyId, row.id]
      );
      if (existing.rows[0]) {
        items.push({
          reportId: row.id,
          accessRequestId: existing.rows[0].id,
          status: existing.rows[0].status,
        });
        continue;
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO access_requests (requesting_company_id, subject_id, report_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [user.companyId, subjectId, row.id]
      );
      items.push({ reportId: row.id, accessRequestId: created.rows[0]!.id, status: "requested" });
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "access_request.search",
      resourceType: "subject",
      resourceId: subjectId,
      metadata: { requestsCreated: items.length },
      ipAddress: ip ?? null,
    });
    return { items };
  });
}


export async function decideAccessRequest(
  admin: AuthUser,
  requestId: string,
  status: "approved" | "denied",
  ip?: string | null
) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ id: string; report_id: string }>(
      `UPDATE access_requests SET status = $2, decided_at = now()
        WHERE id = $1 AND status = 'requested'
        RETURNING id, report_id`,
      [requestId, status]
    );
    if (!res.rows[0]) {
      const exists = await client.query(`SELECT status FROM access_requests WHERE id = $1`, [
        requestId,
      ]);
      if (!exists.rows[0]) throw notFound("Access request not found");
      throw conflict(`Access request is already ${exists.rows[0].status}`);
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "access_request.decide",
      resourceType: "access_request",
      resourceId: requestId,
      metadata: { status, reportId: res.rows[0].report_id },
      ipAddress: ip ?? null,
    });
    return { id: requestId, status };
  });
}

/**
 * Read one report as a company: freely if it's your own; via an APPROVED
 * access request if it's another employer's published report. Cross-company
 * reads are audited individually. (§5 access logging)
 */
export async function getReportAsCompany(user: AuthUser, reportId: string, ip?: string | null) {
  if (!user.companyId) throw forbidden("A company context is required");

  // Own report first (RLS scopes this to the caller's company).
  const own = await withContext(ctxForUser(user), async (client) => {
    const res = await client.query<ReportRow>(`SELECT * FROM conduct_reports WHERE id = $1`, [
      reportId,
    ]);
    return res.rows[0] ?? null;
  });
  if (own) {
    // Your own filing, in full and free of charge: the subject you named, the
    // category standard it was judged against, and the evidence you attached.
    // Nothing here is new information to the caller — they supplied all of it.
    return withContext(ctxForUser(user), async (client) => {
      const detail = await client.query<{
        category_name: string;
        evidence_requirements: string;
        subject_name: string;
        national_id: string | null;
        date_of_birth: string | null;
      }>(
        `SELECT rc.name AS category_name, rc.evidence_requirements,
                s.full_name AS subject_name, s.national_id, s.date_of_birth
           FROM conduct_reports r
           JOIN report_categories rc ON rc.id = r.category_id
           JOIN subjects s ON s.id = r.subject_id
          WHERE r.id = $1`,
        [reportId]
      );
      const evidence = await client.query<{ id: string; content_type: string | null; uploaded_at: string }>(
        `SELECT id, content_type, uploaded_at FROM evidence_files WHERE report_id = $1`,
        [reportId]
      );
      const d = detail.rows[0];
      return {
        ...publicReport(own),
        isOwn: true,
        categoryName: d?.category_name ?? null,
        evidenceRequirements: d?.evidence_requirements ?? null,
        subjectName: d?.subject_name ?? null,
        subjectNationalId: d?.national_id ?? null,
        subjectDateOfBirth: d?.date_of_birth ?? null,
        evidence: evidence.rows.map((e) => ({
          id: e.id,
          contentType: e.content_type,
          uploadedAt: e.uploaded_at,
        })),
      };
    });
  }

  // Cross-company: require an approved access request…
  const grant = await withContext(ctxForUser(user), async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM access_requests
        WHERE requesting_company_id = $1 AND report_id = $2 AND status = 'approved'
        LIMIT 1`,
      [user.companyId, reportId]
    );
    return res.rows[0] ?? null;
  });
  if (!grant) throw forbidden("Access to this report has not been granted");

  // Charge for the view before reading it. Own reports are free — you are not
  // billed to read what you filed. (Pricing Plan §4: view detailed report = 15)
  await withContext(ctxForUser(user), async (client) => {
    await spendCredits(client, {
      companyId: user.companyId!,
      action: "report.view",
      resourceType: "conduct_report",
      resourceId: reportId,
      actorUserId: user.id,
    });
  });

  // …then read via the system context and log the access.
  return withContext(SYSTEM_CTX, async (client) => {
    const res = await client.query(
      `SELECT r.id, r.status, r.narrative_summary, r.created_at, r.expiry_date,
              rc.name AS category_name, c.legal_name AS company_name
         FROM conduct_reports r
         JOIN report_categories rc ON rc.id = r.category_id
         JOIN companies c ON c.id = r.submitted_by_company_id
        WHERE r.id = $1
          AND r.status = 'approved'
          AND (r.expiry_date IS NULL OR r.expiry_date > now())`,
      [reportId]
    );
    if (!res.rows[0]) throw notFound("Report is not available");

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "report.access",
      resourceType: "conduct_report",
      resourceId: reportId,
      metadata: { viaAccessRequest: grant.id, requestingCompanyId: user.companyId },
      ipAddress: ip ?? null,
    });

    const r = res.rows[0];
    return {
      id: r.id,
      status: r.status,
      categoryName: r.category_name,
      narrativeSummary: r.narrative_summary,
      submittedBy: r.company_name,
      createdAt: r.created_at,
      expiryDate: r.expiry_date,
    };
  });
}
