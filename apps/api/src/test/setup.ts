/**
 * Per-file test setup.
 *
 * The rate limiters are a compliance control, so they are deliberately tight
 * (auth: 20 requests / 15 min). Their counters live in Redis and outlive the
 * process, so a suite that registers a dozen companies exhausts the budget and
 * later runs start failing with 429s that have nothing to do with the code.
 *
 * Clear only the `rl:` keys the limiters own — BullMQ's queues share this
 * Redis, so a blanket FLUSHDB would take them with it.
 *
 * This deliberately opens its own connection from process.env rather than
 * importing `lib/redis`: that module pulls in `config/env`, which parses and
 * freezes the environment on first import. Test files set feature flags (e.g.
 * FEATURE_TIER_B_ENABLED) in their module body, which runs after this one — so
 * touching config/env here would lock those flags in at their defaults.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach } from "vitest";
import { config as loadDotenv } from "dotenv";
import Redis from "ioredis";

/**
 * Load the environment ourselves.
 *
 * Setup files run before any test file, so nothing has imported config/env yet
 * and process.env holds only what the shell and vitest.config put there. That
 * is why the Redis cleanup below used to skip silently — REDIS_URL was simply
 * not set at this point. dotenv is loaded directly rather than through
 * config/env for the reason described below: that module freezes the whole
 * environment on first import, which would lock in feature flags that test
 * files set in their own module bodies.
 */
(function loadEnv() {
  // .env.test first so it wins; .env fills in the rest.
  const names = [".env.test", ".env"];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const found = names.map((n) => join(dir, n)).filter(existsSync);
    if (found.length) {
      for (const path of found) loadDotenv({ path });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

/**
 * Refuse to run against anything but a test database.
 *
 * This suite writes freely: it suspends accounts, exhausts rate-limit budgets,
 * and leaves hundreds of rows behind. Pointed at the development database it
 * has already taken out real Super Admin logins and produced failures that were
 * nothing but leftover data. The cost of that mistake is high and the check is
 * one line, so it runs before any test file rather than being left to whoever
 * remembers which .env is loaded.
 *
 * Reads process.env directly for the same reason as the Redis client below —
 * importing config/env here would freeze the environment before test files set
 * their feature flags.
 */
(function refuseNonTestDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — tests need a database");
  // Last path segment, minus any query string.
  const database = new URL(url).pathname.replace(/^\//, "").split("?")[0] ?? "";
  if (!database.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against database "${database}": the name must end ` +
        `with _test. Check that .env.test exists at the repo root and that ` +
        `NODE_ENV=test — see apps/api/src/db/prepare-test-db.ts.`
    );
  }
})();

// Per TEST, not per file: the integration suite issues hundreds of requests in
// well under a minute, which trips the coarse 300/min global limiter partway
// through a run. Clearing between tests keeps the limits themselves untouched.
beforeEach(async () => {
  const url = process.env.REDIS_URL;
  if (!url) return;

  const client = new Redis(url, { maxRetriesPerRequest: null });
  try {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", "rl:*", "COUNT", 500);
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== "0");
  } finally {
    await client.quit();
  }
});
