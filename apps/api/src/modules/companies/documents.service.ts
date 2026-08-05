/**
 * Company verification documents: upload, list, and audited download.
 *
 * Files go to encrypted object storage; the DB keeps only a reference + hash.
 * Downloads return a short-lived presigned URL and are recorded in the audit
 * log (§5: every access to a sensitive record is logged) — this is how a Super
 * Admin viewing an NRC copy becomes a logged, justified access event (concept §4).
 */
import { createHash, randomUUID } from "node:crypto";
import { companyDocsSatisfyVerification, type CompanyDocumentType } from "@hyper/shared";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { presignGet, putObject } from "../../lib/storage";
import { notify, notifyPlatform } from "../notifications/notifications.service";
import type { AuthUser } from "../../types/auth";

const ALLOWED_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

interface DocRow {
  review_status?: string;
  review_reason?: string | null;
  reviewed_at?: string | null;
  id: string;
  doc_type: string;
  content_type: string | null;
  byte_size: string | null;
  uploaded_at: string;
}


function publicDoc(d: DocRow) {
  return {
    id: d.id,
    docType: d.doc_type,
    contentType: d.content_type,
    byteSize: d.byte_size === null ? null : Number(d.byte_size),
    uploadedAt: d.uploaded_at,
    reviewStatus: d.review_status ?? "pending",
    reviewReason: d.review_reason ?? null,
    reviewedAt: d.reviewed_at ?? null,
  };
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export async function uploadCompanyDocument(
  user: AuthUser,
  companyId: string,
  docType: CompanyDocumentType,
  file: UploadFile,
  ip?: string | null
) {
  if (user.companyId !== companyId) {
    throw forbidden("You can only upload documents for your own company");
  }
  if (!ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
    throw badRequest("File must be a PDF, JPEG, or PNG");
  }

  const fileHash = createHash("sha256").update(file.buffer).digest("hex");
  const key = `company-docs/${companyId}/${randomUUID()}`;
  await putObject(key, file.buffer, file.mimetype);

  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<DocRow>(
      `INSERT INTO company_documents
         (company_id, doc_type, storage_ref, file_hash, content_type, byte_size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, doc_type, content_type, byte_size, uploaded_at`,
      [companyId, docType, key, fileHash, file.mimetype, file.size, user.id]
    );
    // Tell reviewers when THIS upload is the one that completes the set. A
    // company that has finished its paperwork is otherwise invisible inside a
    // "companies pending" count that also holds everyone still missing a file.
    //
    // Fired on completion rather than deduplicated per company, so a company
    // that has a document rejected and uploads a replacement is announced
    // again — which is correct: there is something new to review.
    const uploaded = await client.query<{ doc_type: string }>(
      `SELECT DISTINCT doc_type FROM company_documents WHERE company_id = $1`,
      [companyId]
    );
    const types = uploaded.rows.map((r) => r.doc_type);
    const before = types.filter((t) => t !== docType);
    const company = await client.query<{ legal_name: string; status: string }>(
      `SELECT legal_name, status FROM companies WHERE id = $1`,
      [companyId]
    );
    if (
      company.rows[0]?.status === "pending" &&
      companyDocsSatisfyVerification(types) &&
      !companyDocsSatisfyVerification(before)
    ) {
      await notifyPlatform(client, {
        audience: "platform_review",
        kind: "company.documents_ready",
        companyId,
        params: { company: company.rows[0].legal_name },
        link: `/admin/companies/${companyId}`,
      });
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "company.document_upload",
      resourceType: "company_document",
      resourceId: res.rows[0]!.id,
      metadata: { companyId, docType },
      ipAddress: ip ?? null,
    });
    return publicDoc(res.rows[0]!);
  });
}

export async function listCompanyDocuments(companyId: string, ctx: AppContext) {
  return withContext(ctx, async (client) => {
    const res = await client.query<DocRow>(
      `SELECT id, doc_type, content_type, byte_size, uploaded_at,
              review_status, review_reason, reviewed_at
         FROM company_documents WHERE company_id = $1 ORDER BY uploaded_at`,
      [companyId]
    );
    return res.rows.map(publicDoc);
  });
}

export async function getDocumentDownloadUrl(
  user: AuthUser,
  companyId: string,
  docId: string,
  ctx: AppContext,
  ip?: string | null
) {
  return withContext(ctx, async (client) => {
    const res = await client.query<{ storage_ref: string }>(
      `SELECT storage_ref FROM company_documents WHERE id = $1 AND company_id = $2`,
      [docId, companyId]
    );
    if (!res.rows[0]) throw notFound("Document not found");

    // Log the sensitive-document access before handing out the URL.
    await writeAudit(client, {
      actorId: user.id,
      actorType: user.userType === "platform" ? "admin" : "user",
      action: "company.document_access",
      resourceType: "company_document",
      resourceId: docId,
      metadata: { companyId },
      ipAddress: ip ?? null,
    });

    const url = await presignGet(res.rows[0].storage_ref);
    return { url };
  });
}

/**
 * Approve or reject one uploaded document.
 *
 * This is what makes verification mean something: before it existed,
 * `verifyCompany` only checked that a file of each type was present, so a blank
 * page with the right name passed. A rejection must carry a reason — it is the
 * only thing the company can act on — and the reason is sent to them as a
 * notification rather than left for someone to notice.
 *
 * Re-reviewing is allowed: a reviewer who rejects the wrong file, or receives a
 * corrected copy, should not be stuck with their first answer.
 */
export async function reviewCompanyDocument(
  admin: AuthUser,
  companyId: string,
  docId: string,
  input: { decision: "approved" | "rejected"; reason?: string; ip?: string | null }
) {
  if (input.decision === "rejected" && !input.reason?.trim()) {
    throw badRequest("A rejection must say what is wrong with the document");
  }

  return withContext(
    { userType: admin.userType, userId: admin.id, companyId: admin.companyId },
    async (client) => {
      const res = await client.query<{ doc_type: string; review_status: string }>(
        `UPDATE company_documents
            SET review_status = $3,
                review_reason = $4,
                reviewed_by   = $5,
                reviewed_at   = now()
          WHERE id = $1 AND company_id = $2
          RETURNING doc_type, review_status`,
        [docId, companyId, input.decision, input.reason?.trim() ?? null, admin.id]
      );
      if (!res.rows[0]) throw notFound("Document not found");

      await notify(client, {
        companyId,
        kind: input.decision === "rejected" ? "document.rejected" : "document.approved",
        params: { docType: res.rows[0].doc_type, reason: input.reason?.trim() ?? null },
        severity: input.decision === "rejected" ? "warning" : "success",
        link: "/",
      });

      await writeAudit(client, {
        actorId: admin.id,
        actorType: "admin",
        action: `document.${input.decision}`,
        resourceType: "company_document",
        resourceId: docId,
        // The reason is the company's to see; the audit entry records that a
        // decision was made and on what.
        metadata: { companyId, docType: res.rows[0].doc_type },
        ipAddress: input.ip ?? null,
      });

      return { id: docId, docType: res.rows[0].doc_type, reviewStatus: res.rows[0].review_status };
    }
  );
}
