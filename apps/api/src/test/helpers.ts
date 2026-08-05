/** Shared helpers for integration tests. */
import { currentDeclarationVersion } from "@hyper/shared";
import { authenticator } from "otplib";
import { pool } from "../db/pool";
import { hashPassword } from "../modules/auth/password";
import { generateMfaSecret } from "../modules/auth/mfa";

let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function companyRegistrationPayload() {
  const reg = uniq("DICA");
  const email = `${uniq("user")}@example.com`;
  return {
    company: { legalName: `Co ${reg}`, registrationNumber: reg },
    admin: {
      fullName: "Owner",
      email,
      password: "Str0ngPass!",
      // Required since 0024. A real, well-formed NRC so the value exercises
      // normalisation rather than falling through the not-an-NRC path.
      nationalId: "12/OUKAMA(N)123456",
    },
    // Whatever is current, so bumping a declaration does not break every
    // fixture that merely needs a company to exist.
    declaration: {
      accepted: true as const,
      version: currentDeclarationVersion("registration"),
    },
  };
}

/**
 * The declaration accepted when submitting a conduct report, at whatever
 * version is currently on offer. Never hard-code the version in a test: the
 * API refuses a stale one, so a literal turns a deliberate wording change into
 * a pile of unrelated failures.
 */
export function reportDeclaration() {
  return {
    accepted: true as const,
    version: currentDeclarationVersion("report_submission"),
  };
}

/** The company must affirm consent for every new employment check. */
export function verificationAuthorization() {
  return {
    confirmed: true as const,
  };
}

/** A factual source record required before a reviewer completes a check. */
export function verificationSource(response: "employment_confirmed" | "no_record" = "employment_confirmed") {
  return {
    sourceCompany: "Example Previous Employer",
    contactName: "HR Contact",
    contactMethod: "phone" as const,
    response,
    evidenceReference: `hr-call-${uniq("source")}`,
  };
}

/**
 * Provision a platform user with MFA enabled and a known secret, so a test
 * can generate valid TOTP codes for login.
 */
export async function createPlatformUser(
  role: "super_admin" | "admin_reviewer"
) {
  const email = `${uniq(role)}@hyper.local`;
  const password = "Sup3rStrong!";
  const secret = generateMfaSecret();
  const passwordHash = await hashPassword(password);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO platform_users (full_name, email, role, password_hash, mfa_secret, mfa_enabled)
     VALUES ('Platform User', $1, $2, $3, $4, true) RETURNING id`,
    [email, role, passwordHash, secret]
  );
  return {
    id: res.rows[0]!.id,
    email,
    password,
    secret,
    totp: () => authenticator.generate(secret),
  };
}

export async function createSuperAdmin() {
  return createPlatformUser("super_admin");
}

/**
 * Approve every uploaded document for a company.
 *
 * Since migration 0020 verification requires each required document to have
 * been APPROVED, not merely uploaded. Test fixtures that just upload files and
 * expect `/verify` to succeed need this step in between — which is the point of
 * the feature: nobody gets verified without a reviewer opening the documents.
 */
export async function approveCompanyDocuments(
  app: import("express").Express,
  companyId: string,
  adminToken: string
): Promise<void> {
  const request = (await import("supertest")).default;
  const listed = await request(app)
    .get(`/companies/${companyId}/documents`)
    .set("Authorization", `Bearer ${adminToken}`);
  for (const doc of listed.body.items as { id: string }[]) {
    await request(app)
      .post(`/companies/${companyId}/documents/${doc.id}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" });
  }
}

/**
 * Make sure a payment method exists before anything tries to pay with it.
 *
 * Nothing can be bought until an administrator has configured a wallet, so a
 * test that creates a payment intent has to arrange one. It goes through the
 * real admin endpoint rather than a direct insert, because the RLS write policy
 * admits platform staff only and that is the behaviour worth relying on.
 *
 * Call it in every file that pays for something. Depending on another test file
 * having created one first works only by accident of run order, and stops
 * working the moment that file is run alone.
 */
export async function ensurePaymentMethod(
  app: import("express").Express,
  adminToken: string,
  provider: "kbzpay" | "wavepay" | "mmqr" | "bank_transfer" = "kbzpay"
): Promise<void> {
  const request = (await import("supertest")).default;
  await request(app)
    .post("/admin/payment-methods")
    .set("Authorization", `Bearer ${adminToken}`)
    .field("provider", provider)
    .field("displayName", provider)
    .field("accountName", "Dragon Innovation")
    .field("accountNumber", "09-000000000")
    .field("active", "true")
    .expect(200);
}
