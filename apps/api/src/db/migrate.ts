/**
 * Minimal, transparent SQL migration runner.
 *
 * Deliberately raw SQL rather than an ORM's migration DSL: the compliance
 * controls here (RLS policies, append-only audit grants, role privileges) are
 * easiest to review and reason about as plain SQL. Each migration runs in its
 * own transaction as the OWNER role (DATABASE_MIGRATION_URL); the runtime app
 * never has migration privileges.
 *
 * Commands:
 *   tsx src/db/migrate.ts up       apply all pending migrations
 *   tsx src/db/migrate.ts status   list applied vs pending
 *   tsx src/db/migrate.ts seed     run db/seeds/*.sql (idempotent)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "pg";
import { config as loadDotenv } from "dotenv";

/**
 * Read the connection string directly rather than through config/env.
 *
 * That module validates the WHOLE application configuration — S3 credentials,
 * JWT secrets, the subject pepper — and refuses to load without all of it.
 * Applying SQL needs none of that, and requiring it means a deployment's
 * migration step has to be handed every secret the application holds, which is
 * both awkward and more access than the job needs.
 */
function migrationUrl(): string {
  // Same search as config/env: .env.test wins under NODE_ENV=test, .env fills
  // in the rest, and in a container neither exists so the real environment is
  // used as-is.
  const names = process.env.NODE_ENV === "test" ? [".env.test", ".env"] : [".env"];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const found = names.map((n) => join(dir, n)).filter(existsSync);
    if (found.length) {
      for (const path of found) loadDotenv({ path });
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error(
      "DATABASE_MIGRATION_URL is not set. Migrations run as the database OWNER, " +
        "which is a different role from the one the application connects with."
    );
  }
  return url;
}

/** Walk up from here to the repo root (the dir that contains db/migrations). */
function findDbDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "db", "migrations");
    if (existsSync(candidate)) return join(dir, "db");
    dir = dirname(dir);
  }
  throw new Error("could not locate db/migrations from " + __dirname);
}

const DB_DIR = findDbDir();
const MIGRATIONS_DIR = join(DB_DIR, "migrations");
const SEEDS_DIR = join(DB_DIR, "seeds");

function sqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: migrationUrl() });
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(client: Client): Promise<Map<string, string>> {
  const res = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM _migrations"
  );
  return new Map(res.rows.map((r) => [r.name, r.checksum]));
}

/** The leading number, e.g. "0026" from "0026_launch_promotion.sql". */
function ordinal(file: string): string {
  return file.slice(0, 4);
}

/**
 * Refuse a NEW migration that reuses an ordinal.
 *
 * Files are applied in filename order, so two migrations sharing a number are
 * ordered by whatever follows the underscore — alphabetical, arbitrary, and
 * nothing to do with intent. It has happened once already (0024, 0025 and 0026
 * each exist twice, from two people numbering against the same last-seen file),
 * and there it was harmless because those pairs are independent. The next one
 * might not be.
 *
 * Only PENDING files are checked, and only once a database has history. A fresh
 * database replays everything in an order already proven by the environments
 * running it, so blocking there would break new installs to no purpose;
 * renaming migrations that are already applied would be worse still, since the
 * ledger is keyed by filename and they would all re-run.
 */
function assertNoNewOrdinalCollision(files: string[], applied: Map<string, string>): void {
  if (applied.size === 0) return;
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return;

  const taken = new Map<string, string>();
  for (const file of files) if (applied.has(file)) taken.set(ordinal(file), file);

  const clashes: string[] = [];
  for (const file of pending) {
    const existing = taken.get(ordinal(file));
    if (existing) clashes.push(`  ${file} reuses the number of ${existing} (already applied)`);
    else taken.set(ordinal(file), file);
  }
  if (clashes.length) {
    throw new Error(
      `migration numbering conflict:\n${clashes.join("\n")}\n` +
        `Renumber the new file(s) above the highest existing migration.`
    );
  }
}

async function up(): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const files = sqlFiles(MIGRATIONS_DIR);
    assertNoNewOrdinalCollision(files, applied);
    let ran = 0;

    for (const file of files) {
      const contents = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const sum = checksum(contents);
      const prior = applied.get(file);

      if (prior) {
        if (prior !== sum) {
          throw new Error(
            `migration ${file} was modified after being applied ` +
              `(checksum mismatch) — migrations are immutable once applied`
          );
        }
        continue;
      }

      process.stdout.write(`→ applying ${file} ... `);
      try {
        await client.query("BEGIN");
        await client.query(contents);
        await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
          file,
          sum,
        ]);
        await client.query("COMMIT");
        process.stdout.write("ok\n");
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        process.stdout.write("failed\n");
        throw err;
      }
    }

    console.log(ran === 0 ? "Already up to date." : `Applied ${ran} migration(s).`);
  } finally {
    await client.end();
  }
}

async function status(): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const files = sqlFiles(MIGRATIONS_DIR);
    console.log("Migrations:");
    for (const file of files) {
      console.log(`  [${applied.has(file) ? "x" : " "}] ${file}`);
    }
  } finally {
    await client.end();
  }
}

async function seed(): Promise<void> {
  const client = await connect();
  try {
    const files = sqlFiles(SEEDS_DIR);
    if (files.length === 0) {
      console.log("No seed files.");
      return;
    }
    for (const file of files) {
      process.stdout.write(`→ seeding ${file} ... `);
      const contents = readFileSync(join(SEEDS_DIR, file), "utf8");
      await client.query(contents);
      process.stdout.write("ok\n");
    }
    console.log(`Ran ${files.length} seed file(s).`);
  } finally {
    await client.end();
  }
}

const command = process.argv[2] ?? "up";

const run =
  command === "up" ? up : command === "status" ? status : command === "seed" ? seed : null;

if (!run) {
  console.error(`Unknown command: ${command}. Use: up | status | seed`);
  process.exit(1);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Keep the resolved path importable for tests.
export const paths = { DB_DIR: resolve(DB_DIR), MIGRATIONS_DIR, SEEDS_DIR };
