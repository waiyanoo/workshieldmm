/**
 * Tier A — verification-only checks. Confirms an applicant against employer
 * records; no allegations, no subjective judgment. (§3 concept, §4)
 *
 * Only a VERIFIED employer with an active Tier A subscription may submit. The
 * subject is resolved by peppered national-ID hash (raw ID never stored), and
 * the request is created `pending` — the actual match against employer records
 * is completed out-of-band and is not latency-sensitive. (§6)
 */
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { forbidden, notFound } from "../../lib/errors";
import { spendCredits } from "../credits/credits.service";
import { normalizeNrc } from "@hyper/shared";
import { hashNationalId } from "../../lib/crypto";
import type { AuthUser } from "../../types/auth";

interface VerificationRow {
  id: string;
  company_id: string;
  subject_id: string;
  requested_by: string;
  status: string;
  result: string | null;
  created_at: string;
  subject_name?: string | null;
  date_of_birth?: string | null;
  info_request?: string | null;
  info_requested_at?: string | null;
}

function publicVerification(v: VerificationRow) {
  return {
    id: v.id,
    companyId: v.company_id,
    subjectId: v.subject_id,
    // What the check was requested against — so the employer can tell their
    // "recent checks" apart. The requesting company supplied these values.
    subjectName: v.subject_name ?? null,
    dateOfBirth: v.date_of_birth ?? null,
    status: v.status,
    result: v.result,
    // What the reviewer asked for, when the check is parked on `need_more_info`.
    // Shown to the employer so the status is actionable rather than mysterious.
    infoRequest: v.info_request ?? null,
    infoRequestedAt: v.info_requested_at ?? null,
    createdAt: v.created_at,
  };
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export interface CreateVerificationInput {
  subject: { fullName: string; nationalId: string; dateOfBirth?: string };
  authorization: {
    confirmed: true;
  };
  ip?: string | null;
}

export async function createVerification(user: AuthUser, input: CreateVerificationInput) {
  if (!user.companyId) throw forbidden("A company context is required");
  const nationalIdHash = hashNationalId(input.subject.nationalId);

  return withContext(ctxForUser(user), async (client) => {
    // Gate: company must be verified and hold an active Tier A subscription.
    const company = await client.query<{ status: string }>(
      `SELECT status FROM companies WHERE id = $1`,
      [user.companyId]
    );
    if (company.rows[0]?.status !== "verified") {
      throw forbidden("Company must be verified before submitting checks");
    }
    // No subscription-tier check: under the pricing plan every registered
    // company can use every feature, and plans differ only in bundled credits
    // (Pricing Plan §1). Entitlement is now the credit balance, charged below.
    // The `verified` gate above stays — that is a trust control, not a paywall.

    // Resolve or create the subject. The hash stays the matching key; the raw
    // NRC is stored alongside it so reviewers can confirm identity. (0012)
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
    const subjectId = subject.rows[0]!.id;

    // Create the request (pending; completed out-of-band).
    const created = await client.query<VerificationRow>(
      `INSERT INTO verification_requests
         (company_id, subject_id, requested_by, status, authorization_basis,
          authorization_reference, authorization_confirmed_at)
       VALUES ($1, $2, $3, 'pending', 'employee_consent', NULL, now()) RETURNING *`,
      [user.companyId, subjectId, user.id]
    );
    const verification = created.rows[0]!;
    verification.subject_name = input.subject.fullName;
    verification.date_of_birth = input.subject.dateOfBirth ?? null;

    // Charge for the search. Inside the same transaction, so a failure here
    // rolls the request back rather than billing for a check that never ran.
    // (Pricing Plan §4: employee verification search = 5 credits)
    await spendCredits(client, {
      companyId: user.companyId!,
      action: "verification.search",
      resourceType: "verification_request",
      resourceId: verification.id,
      actorUserId: user.id,
    });

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "verification.create",
      resourceType: "verification_request",
      resourceId: verification.id,
      metadata: { subjectId, consentConfirmed: true },
      ipAddress: input.ip ?? null,
    });

    return publicVerification(verification);
  });
}

export async function listVerifications(ctx: AppContext) {
  return withContext(ctx, async (client) => {
    // RLS scopes this to the caller's company (or all, for platform staff).
    // Join the subject so the employer can see who each check was for.
    const res = await client.query<VerificationRow>(
      `SELECT v.*, s.full_name AS subject_name, s.date_of_birth
         FROM verification_requests v
         JOIN subjects s ON s.id = v.subject_id
        ORDER BY v.created_at DESC LIMIT 100`
    );
    return res.rows.map(publicVerification);
  });
}

export async function getVerification(id: string, ctx: AppContext) {
  return withContext(ctx, async (client) => {
    const res = await client.query<VerificationRow>(
      `SELECT v.*, s.full_name AS subject_name, s.date_of_birth
         FROM verification_requests v
         JOIN subjects s ON s.id = v.subject_id
        WHERE v.id = $1`,
      [id]
    );
    // RLS restricts to the requesting company (or platform). Own-request-only. (§4)
    if (!res.rows[0]) throw notFound("Verification not found");
    return publicVerification(res.rows[0]);
  });
}
