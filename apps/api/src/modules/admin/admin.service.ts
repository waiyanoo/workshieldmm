/**
 * Admin surfaces: the verification review queue and the audit-log reader.
 *
 * - Verification decisions (pending → completed | not_found) are made by
 *   platform reviewers, never by the requesting employer. The decision and its
 *   audit entry commit in one transaction. (§4)
 * - Reading the audit trail is Super Admin only and is ITSELF logged in the
 *   same transaction — per §4: "Read audit trail — Super Admin only, itself
 *   logged."
 */
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { notify } from "../notifications/notifications.service";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

// --- Verification review -----------------------------------------------------

interface ReviewRow {
  id: string;
  company_id: string;
  company_name: string;
  subject_id: string;
  subject_name: string;
  national_id: string | null;
  date_of_birth: string | null;
  status: string;
  result: string | null;
  created_at: string;
}

function publicReviewItem(r: ReviewRow) {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    subjectId: r.subject_id,
    subjectName: r.subject_name,
    // Shown so the reviewer can confirm they have the right person. (0012)
    nationalId: r.national_id,
    dateOfBirth: r.date_of_birth,
    status: r.status,
    result: r.result,
    createdAt: r.created_at,
  };
}

export async function listVerificationsForReview(admin: AuthUser, status: string) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<ReviewRow>(
      `SELECT v.id, v.company_id, v.subject_id, v.status, v.result, v.created_at,
              c.legal_name AS company_name,
              s.full_name  AS subject_name, s.national_id, s.date_of_birth
         FROM verification_requests v
         JOIN companies c ON c.id = v.company_id
         JOIN subjects  s ON s.id = v.subject_id
        WHERE v.status = $1
        ORDER BY v.created_at
        LIMIT 100`,
      [status]
    );
    return res.rows.map(publicReviewItem);
  });
}

/**
 * Everything the platform already knows about the person a check was raised
 * against, so the reviewer isn't deciding blind.
 *
 * IMPORTANT — what this is not: the platform holds no employment records, so
 * none of this confirms that the applicant actually worked somewhere. It shows
 * whether this NRC is *known to the platform* and what other companies have
 * asked about them. Confirming employment dates is still an out-of-band step
 * the reviewer performs against the employer's own records. Until an
 * employment-records store exists, "Record confirmed" is the reviewer
 * attesting to something they checked elsewhere. (concept §3.1 Tier A)
 */
export async function getVerificationContext(admin: AuthUser, verificationId: string) {
  return withContext(ctxForUser(admin), async (client) => {
    const req = await client.query<{
      subject_id: string;
      company_id: string;
      authorization_basis: string;
      authorization_confirmed_at: string | null;
    }>(
      `SELECT subject_id, company_id, authorization_basis, authorization_confirmed_at
         FROM verification_requests WHERE id = $1`,
      [verificationId]
    );
    if (!req.rows[0]) throw notFound("Verification not found");
    const { subject_id: subjectId, company_id: companyId } = req.rows[0];

    const subject = await client.query<{
      full_name: string;
      national_id: string | null;
      date_of_birth: string | null;
      created_at: string;
    }>(
      `SELECT full_name, national_id, date_of_birth, created_at
         FROM subjects WHERE id = $1`,
      [subjectId]
    );

    // Other checks raised against the same person, by any company.
    const priorChecks = await client.query<{
      company_name: string;
      status: string;
      result: string | null;
      created_at: string;
      is_same_company: boolean;
    }>(
      `SELECT c.legal_name AS company_name, v.status, v.result, v.created_at,
              (v.company_id = $2) AS is_same_company
         FROM verification_requests v
         JOIN companies c ON c.id = v.company_id
        WHERE v.subject_id = $1 AND v.id <> $3
        ORDER BY v.created_at DESC
        LIMIT 20`,
      [subjectId, companyId, verificationId]
    );

    // Published conduct reports naming the same person. Metadata only — the
    // narrative stays behind the audited per-report open.
    const reports = await client.query<{ category_name: string; status: string; created_at: string }>(
      `SELECT rc.name AS category_name, r.status, r.created_at
         FROM conduct_reports r
         JOIN report_categories rc ON rc.id = r.category_id
        WHERE r.subject_id = $1 AND r.status = 'approved'
        ORDER BY r.created_at DESC
        LIMIT 20`,
      [subjectId]
    );

    const sources = await client.query<{
      source_company: string;
      contact_name: string;
      contact_method: string;
      response: string;
      employment_start_date: string | null;
      employment_end_date: string | null;
      evidence_reference: string | null;
      verified_at: string;
      reviewer_name: string;
    }>(
      `SELECT vs.source_company, vs.contact_name, vs.contact_method, vs.response,
              vs.employment_start_date, vs.employment_end_date, vs.evidence_reference,
              vs.verified_at, p.full_name AS reviewer_name
         FROM verification_sources vs
         JOIN platform_users p ON p.id = vs.reviewer_id
        WHERE vs.verification_id = $1
        ORDER BY vs.verified_at DESC`,
      [verificationId]
    );

    return {
      subject: {
        fullName: subject.rows[0]?.full_name ?? null,
        nationalId: subject.rows[0]?.national_id ?? null,
        dateOfBirth: subject.rows[0]?.date_of_birth ?? null,
        // First time this NRC was seen by the platform at all.
        knownSince: subject.rows[0]?.created_at ?? null,
      },
      priorChecks: priorChecks.rows.map((p) => ({
        companyName: p.company_name,
        status: p.status,
        result: p.result,
        createdAt: p.created_at,
        isSameCompany: p.is_same_company,
      })),
      publishedReports: reports.rows.map((r) => ({
        categoryName: r.category_name,
        status: r.status,
        createdAt: r.created_at,
      })),
      sources: sources.rows.map((s) => ({
        sourceCompany: s.source_company,
        contactName: s.contact_name,
        contactMethod: s.contact_method,
        response: s.response,
        employmentStartDate: s.employment_start_date,
        employmentEndDate: s.employment_end_date,
        evidenceReference: s.evidence_reference,
        verifiedAt: s.verified_at,
        reviewerName: s.reviewer_name,
      })),
      consent: {
        isLegacy: req.rows[0].authorization_basis === "legacy_no_record",
        confirmedAt: req.rows[0].authorization_confirmed_at,
      },
    };
  });
}

const DEFAULT_RESULTS: Record<string, string> = {
  completed: "Employment record confirmed",
  not_found: "No record found",
};

export async function decideVerification(
  admin: AuthUser,
  verificationId: string,
  decision: {
    status: "completed" | "not_found";
    result?: string;
    source: {
      sourceCompany: string;
      contactName: string;
      contactDetails?: string;
      contactMethod: "phone" | "email" | "letter" | "portal" | "in_person" | "document" | "other";
      response: "employment_confirmed" | "no_record" | "unable_to_confirm";
      employmentStartDate?: string;
      employmentEndDate?: string;
      evidenceReference?: string;
      verifiedAt?: string;
    };
  },
  ip?: string | null
) {
  const result = decision.result?.trim() || DEFAULT_RESULTS[decision.status]!;

  if (
    (decision.status === "completed" && decision.source.response !== "employment_confirmed") ||
    (decision.status === "not_found" && decision.source.response === "employment_confirmed")
  ) {
    throw badRequest("The source response must match the verification outcome");
  }

  return withContext(ctxForUser(admin), async (client) => {
    const updated = await client.query<ReviewRow>(
      // `need_more_info` is decidable too: a reviewer who asked the employer a
      // question and then found the answer elsewhere should not have to wait
      // for a reply they no longer need. `decided_at` is what the turnaround
      // figures in queue.service are measured from.
      `UPDATE verification_requests
          SET status = $2, result = $3, decided_at = now()
        WHERE id = $1 AND status IN ('pending', 'need_more_info')
        RETURNING id, company_id, status, result, created_at,
                  ''::text AS company_name, ''::text AS subject_name`,
      [verificationId, decision.status, result]
    );

    if (!updated.rows[0]) {
      // Distinguish "doesn't exist" from "already decided" for a clear error.
      const exists = await client.query(`SELECT status FROM verification_requests WHERE id = $1`, [
        verificationId,
      ]);
      if (!exists.rows[0]) throw notFound("Verification not found");
      throw conflict(`Verification is already ${exists.rows[0].status}`);
    }

    await client.query(
      `INSERT INTO verification_sources
         (verification_id, reviewer_id, source_company, contact_name, contact_details,
          contact_method, response, employment_start_date, employment_end_date,
          evidence_reference, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))`,
      [
        verificationId,
        admin.id,
        decision.source.sourceCompany,
        decision.source.contactName,
        decision.source.contactDetails?.trim() || null,
        decision.source.contactMethod,
        decision.source.response,
        decision.source.employmentStartDate ?? null,
        decision.source.employmentEndDate ?? null,
        decision.source.evidenceReference?.trim() || null,
        decision.source.verifiedAt ?? null,
      ]
    );

    await notify(client, {
      companyId: updated.rows[0].company_id,
      kind: "verification.completed",
      params: { outcome: decision.status, result },
      severity: decision.status === "completed" ? "success" : "info",
      link: "/verifications",
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "verification.decide",
      resourceType: "verification_request",
      resourceId: verificationId,
      metadata: { status: decision.status, sourceMethod: decision.source.contactMethod },
      ipAddress: ip ?? null,
    });

    const row = updated.rows[0];
    return { id: row.id, status: row.status, result: row.result, createdAt: row.created_at };
  });
}

// --- Audit log reader ---------------------------------------------------------

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  timestamp: string;
}

export interface AuditQuery {
  limit: number;
  offset: number;
  action?: string;
  resourceType?: string;
}

export async function readAuditLogs(admin: AuthUser, q: AuditQuery, ip?: string | null) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<AuditRow>(
      `SELECT id, actor_id, actor_type, action, resource_type, resource_id,
              metadata, ip_address, "timestamp"
         FROM audit.audit_logs
        WHERE ($1::text IS NULL OR action = $1)
          AND ($2::text IS NULL OR resource_type = $2)
        ORDER BY id DESC
        LIMIT $3 OFFSET $4`,
      [q.action ?? null, q.resourceType ?? null, q.limit, q.offset]
    );

    // The read itself is an auditable access to sensitive data. (§4)
    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "audit.read",
      resourceType: "audit_logs",
      metadata: {
        limit: q.limit,
        offset: q.offset,
        ...(q.action ? { action: q.action } : {}),
        ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      },
      ipAddress: ip ?? null,
    });

    return res.rows.map((r) => ({
      id: Number(r.id),
      actorId: r.actor_id,
      actorType: r.actor_type,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      metadata: r.metadata,
      ipAddress: r.ip_address,
      timestamp: r.timestamp,
    }));
  });
}
