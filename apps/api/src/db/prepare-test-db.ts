/**
 * Create and migrate the test database.
 *
 * Run automatically by `npm test`. Idempotent: on a database that already
 * exists it only applies migrations that are missing, which is a no-op most of
 * the time and costs about a second.
 *
 * This deliberately does NOT import config/env. That module validates and
 * freezes the whole environment on first import, and ES imports are evaluated
 * before any statement in this file — so there would be no way to set
 * NODE_ENV=test in time. Bootstrapping reads the raw values instead, which is
 * also more honest: this script's job is to build the thing the validated
 * config later expects to find.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Client } from "pg";

/** Walk up to the repo root — the directory holding .env.test. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, ".env.test")) || existsSync(join(dir, ".env"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find the repo root (no .env or .env.test above " + process.cwd() + ")");
}

const root = findRepoRoot();
const testEnvPath = join(root, ".env.test");
if (!existsSync(testEnvPath)) {
  console.error(
    `No .env.test at ${testEnvPath}.\n` +
      `Copy .env and change the database name to end with _test (and point ` +
      `REDIS_URL at a different Redis database, e.g. redis://localhost:6379/1).`
  );
  process.exit(1);
}
// .env.test first so it wins; .env fills in everything it does not mention.
loadDotenv({ path: testEnvPath });
loadDotenv({ path: join(root, ".env") });

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const appUrl = process.env.DATABASE_URL;
if (!migrationUrl || !appUrl) {
  console.error("DATABASE_MIGRATION_URL and DATABASE_URL must both be set in .env.test/.env");
  process.exit(1);
}

const parsed = new URL(migrationUrl);
const database = parsed.pathname.replace(/^\//, "");
const appRole = decodeURIComponent(new URL(appUrl).username);

// The same guard the suite itself applies. Creating and migrating a database
// is harmless; doing it to the development one by accident is not.
if (!database.endsWith("_test")) {
  console.error(
    `Refusing to prepare "${database}": the test database name must end with _test.`
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // CREATE DATABASE cannot run inside a transaction, and cannot run from a
  // connection to the database being created — so connect to `postgres`.
  // The database has to be swapped in the URL itself: pg lets the connection
  // string win over a separate `database` option, so passing both silently
  // connects to the database that does not exist yet.
  const adminUrl = new URL(migrationUrl!);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database]);
    if (exists.rowCount === 0) {
      // Identifiers cannot be parameterised; the _test suffix check above plus
      // this quoting keep it safe.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`created database ${database}`);
    } else {
      console.log(`database ${database} already exists`);
    }
  } finally {
    await admin.end();
  }

  // 0001 grants CONNECT on the literal database name `hyper`, so the app role
  // needs the equivalent grant here. PUBLIC usually has CONNECT anyway; being
  // explicit means the test database does not depend on that default.
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const role = await owner.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [appRole]);
    if (role.rowCount) {
      await owner.query(
        `GRANT CONNECT ON DATABASE "${database.replace(/"/g, '""')}" TO "${appRole.replace(/"/g, '""')}"`
      );
    }
  } finally {
    await owner.end();
  }

  // Migrations run in a child process because migrate.ts is a CLI: importing it
  // executes a command. NODE_ENV=test makes its config load .env.test.
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(__dirname, "migrate.ts"), "up"],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } }
  );
  if (result.status !== 0) {
    console.error("migrations failed against the test database");
    process.exit(result.status ?? 1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
