/**
 * Status vocabularies and the report-category policy.
 *
 * These enums are the single source of truth shared by the API state machines,
 * the database CHECK constraints (kept in sync by migrations), and the web UI.
 */

// --- Companies -------------------------------------------------------------
export const COMPANY_STATUSES = ["pending", "verified", "suspended"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

// --- Subscriptions ---------------------------------------------------------
export const SUBSCRIPTION_TIERS = ["A", "B"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_STATUSES = ["active", "past_due", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// --- Tier A: verification requests -----------------------------------------
export const VERIFICATION_STATUSES = ["pending", "completed", "not_found"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// --- Tier B: conduct reports -----------------------------------------------
// Direct-publish model: a reviewer's evidence-sufficient decision publishes the
// report. There is no notice or dispute stage — the accuracy safeguards are the
// evidence gate and the correction path (withdraw / correct).
export const REPORT_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "expired",
  "withdrawn",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Statuses in which a report is visible to an employer other than its author. */
export const PUBLISHED_REPORT_STATUSES = ["approved"] as const;

// --- Tier B: review / dispute ----------------------------------------------
export const REVIEW_DECISIONS = ["evidence_sufficient", "evidence_insufficient"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const ACCESS_REQUEST_STATUSES = ["requested", "approved", "denied"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

// --- Audit -----------------------------------------------------------------
export const ACTOR_TYPES = ["user", "admin", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Categories that can NEVER be used for an adverse conduct report. Enforced at
 * the data layer (report_categories.eligible = false), not just the UI, so a
 * client bug can't create a report against protected activity. (§3.2 / concept §5)
 *
 * This list is policy-controlled, not developer-editable at runtime — it is
 * seeded and changed only through a reviewed migration.
 */
// --- Company verification documents ----------------------------------------
// Business legitimacy is established by a DICA certificate OR a shop license;
// the person in charge is established by an NRC copy. (product decision)
export const COMPANY_DOCUMENT_TYPES = ["dica_certificate", "shop_license", "nrc"] as const;
export type CompanyDocumentType = (typeof COMPANY_DOCUMENT_TYPES)[number];

/**
 * A company may only be verified once it has (a DICA certificate OR a shop
 * license) AND an NRC copy for the person in charge. Enforced server-side, not
 * just in the UI.
 */
export function companyDocsSatisfyVerification(types: readonly string[]): boolean {
  const present = new Set(types);
  const hasBusinessDoc = present.has("dica_certificate") || present.has("shop_license");
  return hasBusinessDoc && present.has("nrc");
}

/**
 * Which required documents are still outstanding, so the company can be told
 * exactly what to fix rather than "documents missing".
 *
 * Callers pass the APPROVED document types — a rejected or unreviewed file is
 * not a satisfied requirement. (0020)
 */
export function missingRequiredDocs(approvedTypes: readonly string[]): string[] {
  const present = new Set(approvedTypes);
  const missing: string[] = [];
  if (!present.has("dica_certificate") && !present.has("shop_license")) {
    missing.push("business_document");
  }
  if (!present.has("nrc")) missing.push("nrc");
  return missing;
}

export const EXCLUDED_REPORT_CATEGORIES = [
  "union_or_labor_organizing",
  "wage_or_hour_dispute",
  "voluntary_resignation",
  "medical_or_family_leave",
  "political_affiliation",
] as const;
export type ExcludedReportCategory = (typeof EXCLUDED_REPORT_CATEGORIES)[number];
