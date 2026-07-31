/**
 * TOTP-based MFA (otplib). Required for Admin Reviewer, Super Admin, and Review
 * Board accounts (§2, concept §4). Platform users are provisioned with MFA
 * already enabled; company users can opt in via the setup/verify endpoints.
 */
import { authenticator } from "otplib";

const ISSUER = "Hyper Platform";

// Accept the adjacent 30s steps as well, to tolerate small clock skew between
// the server and the user's authenticator app (standard TOTP practice).
authenticator.options = { window: 1 };

export function generateMfaSecret(): string {
  return authenticator.generateSecret();
}

/** otpauth:// URI to enroll the secret in an authenticator app. */
export function mfaKeyUri(accountEmail: string, secret: string): string {
  return authenticator.keyuri(accountEmail, ISSUER, secret);
}

export function verifyMfaCode(code: string, secret: string): boolean {
  return authenticator.verify({ token: code, secret });
}
