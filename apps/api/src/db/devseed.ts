/**
 * Development seed — a verified company, a reviewer, and enough activity to
 * see the new screens do something.
 *
 * Not wired into any npm script and never run in production: it writes known
 * passwords. Run it with `npx tsx src/db/devseed.ts` from apps/api when you
 * need a local login.
 */
import { pool, withContext } from "./pool";
import { hashPassword } from "../modules/auth/password";
import { generateMfaSecret } from "../modules/auth/mfa";

const COMPANY_EMAIL = "hr@demo.mm";
const COMPANY_PASSWORD = "DemoCompany!1";
const ADMIN_EMAIL = "reviewer@hyper.local";
const ADMIN_PASSWORD = "DemoReviewer!1";

async function main() {
  // Platform context: the app connects as the limited `hyper_app` role, so
  // without it row-level security refuses these writes — correctly.
  const secret = await withContext({ userType: "platform" }, async (pool) => {
  const companyHash = await hashPassword(COMPANY_PASSWORD);
  const adminHash = await hashPassword(ADMIN_PASSWORD);
  const secret = generateMfaSecret();

  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (legal_name, registration_number, status, plan,
                            registration_verified_at, phone, address_line, city, region)
     VALUES ('Demo Trading Co., Ltd.', 'DICA-DEMO-0001', 'verified', 'starter', now(),
             '09 771 234 567', 'No. 12, Pyay Road', 'Yangon', 'Yangon Region')
     ON CONFLICT (registration_number) DO UPDATE SET status = 'verified'
     RETURNING id`
  );
  const companyId = company.rows[0]!.id;

  await pool.query(
    `INSERT INTO company_users (company_id, full_name, email, role, password_hash)
     VALUES ($1, 'Daw Hla Hla', $2, 'company_admin', $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [companyId, COMPANY_EMAIL, companyHash]
  );

  await pool.query(
    `INSERT INTO platform_users (full_name, email, role, password_hash, mfa_secret, mfa_enabled)
     VALUES ('Demo Reviewer', $1, 'super_admin', $2, $3, true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, mfa_secret = EXCLUDED.mfa_secret`,
    [ADMIN_EMAIL, adminHash, secret]
  );

  // Credits, so the company can actually run a check.
  await pool.query(
    `INSERT INTO credit_lots (company_id, amount, remaining, reason, granted_at, expires_at)
     VALUES ($1, 200, 200, 'purchase', now(), now() + interval '6 months')`,
    [companyId]
  );

    return secret;
  });

  console.log("Company : %s / %s", COMPANY_EMAIL, COMPANY_PASSWORD);
  console.log("Reviewer: %s / %s", ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log("Reviewer MFA secret: %s", secret);
  await pool.end();
}

void main();
