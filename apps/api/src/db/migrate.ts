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
import { env } from "../config/env";

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
  const client = new Client({ connectionString: env.DATABASE_MIGRATION_URL });
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

async function up(): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const files = sqlFiles(MIGRATIONS_DIR);
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
