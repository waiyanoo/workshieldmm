/**
 * Background worker process. Run separately from the API:
 *   npm run worker -w @hyper/api
 *
 * Handles the lifecycle sweep (every 15 min): expiring + anonymizing reports
 * past their retention date. (§5 Retention & expiry)
 */
import { Worker } from "bullmq";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { pool } from "../db/pool";
import { redis } from "../lib/redis";
import { expireReports, warnExpiringPromotions } from "./lifecycle";
import {
  expireCredits,
  grantMonthlyCredits,
  lapseExpiredPlans,
} from "../modules/credits/plans.service";
import { expirePaymentIntents } from "../modules/payments/payments.service";
import { getLifecycleQueue, closeQueues } from "./queues";

const connection = { url: env.REDIS_URL };

const lifecycleWorker = new Worker(
  "lifecycle",
  async () => {
    const expired = await expireReports();
    if (expired.length) logger.info({ expired }, "lifecycle sweep expired reports");

    // Plans whose paid period ended drop to Free BEFORE the grant runs, so a
    // lapsed subscription never receives one more month of credits.
    const downgraded = await lapseExpiredPlans();
    if (downgraded) logger.info({ downgraded }, "plans lapsed to free");

    // Bundled credits are granted once per calendar month (idempotent), and
    // anything past its lifetime lapses (1/3/6 months by source). (0018)
    const granted = await grantMonthlyCredits();
    if (granted.length) logger.info({ granted: granted.length }, "monthly credits granted");

    const lapsed = await expireCredits();
    if (lapsed) logger.info({ lapsed }, "credit lots expired");

    // Unpaid purchase requests lapse so the queue and reference codes stay real.
    const staleIntents = await expirePaymentIntents();
    if (staleIntents) logger.info({ staleIntents }, "payment intents expired");

    // Super Admins hear about a promotion ending before their customers do.
    const promos = await warnExpiringPromotions();
    if (promos.length) logger.info({ promos }, "promotion expiry warnings raised");
  },
  { connection }
);

async function main() {
  await getLifecycleQueue().add(
    "sweep",
    {},
    { repeat: { every: 15 * 60 * 1000 }, removeOnComplete: 100, removeOnFail: 100 }
  );
  logger.info("worker running: lifecycle (15m sweep)");
}

async function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down");
  await Promise.allSettled([lifecycleWorker.close(), closeQueues(), pool.end(), redis.quit()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
