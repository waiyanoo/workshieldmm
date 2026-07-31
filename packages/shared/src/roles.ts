/**
 * Roles across the platform. Two distinct user populations:
 *  - Platform staff (super_admin, admin_reviewer, review_board) — internal.
 *  - Company users (company_admin, company_user) — subscribing employers.
 *
 * Data subjects (the individual a check/report concerns) intentionally have
 * NO login (concept §4); they act through signed, single-purpose tokens.
 */

export const PLATFORM_ROLES = ["super_admin", "admin_reviewer", "review_board"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const COMPANY_ROLES = ["company_admin", "company_user"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export type UserType = "platform" | "company";

export type Role = PlatformRole | CompanyRole;

/**
 * Roles that MUST complete MFA to hold a session. (Tech doc §2 Auth:
 * "MFA required for Admin Reviewer and Super Admin roles"; concept §4 adds
 * the Review Board.)
 */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  "super_admin",
  "admin_reviewer",
  "review_board",
];

export function isPlatformRole(role: string): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}

export function isCompanyRole(role: string): role is CompanyRole {
  return (COMPANY_ROLES as readonly string[]).includes(role);
}

export function mfaRequiredFor(role: Role): boolean {
  return MFA_REQUIRED_ROLES.includes(role);
}
