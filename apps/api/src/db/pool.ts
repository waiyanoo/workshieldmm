/**
 * Database access layer.
 *
 * The app connects as the limited `hyper_app` role (see migration 0001) so the
 * row-level-security policies and append-only audit grants actually constrain
 * it. Every request that touches tenant data runs inside `withContext`, which
 * opens a transaction and sets the `app.*` session GUCs with SET LOCAL — the
 * exact keys the RLS policies in 0004 read. SET LOCAL is scoped to the
 * transaction, so context can never leak across pooled connections.
 */
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Return SQL `date` columns as plain "YYYY-MM-DD" strings.
 *
 * A date of birth is a calendar date, not an instant. node-pg's default parser
 * turns a `date` into a JS Date at LOCAL midnight, which JSON then serialises
 * as UTC — so a subject born 1994-02-17, read on a server in Myanmar (UTC+6:30),
 * left the API as "1994-02-16T17:30:00.000Z" and displayed as the 16th to
 * anyone not in that timezone. The stored value was always correct; only the
 * round-trip was wrong.
 *
 * Keeping the string means nothing can shift it. Timestamps (`timestamptz`)
 * are genuine instants and keep their normal Date parsing — this deliberately
 * only covers OID 1082 (`date`): subjects.date_of_birth and the subscription
 * period dates.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "unexpected idle postgres client error");
});

/** The identity a query runs under; drives row-level security. */
export interface AppContext {
  userType: "company" | "platform" | "subject" | "system";
  userId?: string;
  companyId?: string;
}

/** Simple pooled query for context-free reads (health checks, lookups). */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

/**
 * Run `fn` inside a transaction with the RLS session variables set for `ctx`.
 * Commits on success, rolls back on any throw. All tenant-scoped work — and its
 * in-transaction audit write — should go through here so the audit entry and
 * the change it records commit or fail together. (§4)
 */
export async function withContext<T>(
  ctx: AppContext,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_type', $1, true)", [ctx.userType]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId ?? ""]);
    await client.query("SELECT set_config('app.company_id', $1, true)", [ctx.companyId ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
