/**
 * Provision a platform staff account (super_admin | admin_reviewer |
 * review_board). These roles are never self-registered. MFA is enabled at
 * creation and the enrollment URL is printed once — capture it into an
 * authenticator app. (§2 MFA, concept §4)
 *
 * Usage:
 *   npm run create:platform-user -w @hyper/api -- \
 *     --email admin@hyper.local --name "Admin" --role super_admin --password 'Str0ngPass!'
 */
import { PLATFORM_ROLES, type PlatformRole } from "@hyper/shared";
import { pool } from "../db/pool";
import { hashPassword } from "../modules/auth/password";
import { generateMfaSecret, mfaKeyUri } from "../modules/auth/mfa";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email");
  const name = arg("name");
  const role = arg("role") as PlatformRole | undefined;
  const password = arg("password");

  if (!email || !name || !role || !password) {
    console.error("Missing required args: --email --name --role --password");
    process.exit(1);
  }
  if (!(PLATFORM_ROLES as readonly string[]).includes(role)) {
    console.error(`--role must be one of: ${PLATFORM_ROLES.join(", ")}`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("--password must be at least 8 characters");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const secret = generateMfaSecret();

  const res = await pool.query<{ id: string }>(
    `INSERT INTO platform_users (full_name, email, role, password_hash, mfa_secret, mfa_enabled)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id`,
    [name, email, role, passwordHash, secret]
  );

  console.log(`Created platform user ${res.rows[0]!.id} (${role})`);
  console.log("Enroll this MFA secret in an authenticator app (shown once):");
  console.log(`  otpauth URL: ${mfaKeyUri(email, secret)}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
