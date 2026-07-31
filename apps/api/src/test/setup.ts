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
import { beforeEach } from "vitest";
import Redis from "ioredis";

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
