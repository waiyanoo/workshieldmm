/**
 * HTTP entrypoint. Boots the app and wires graceful shutdown so in-flight
 * requests (and their in-transaction audit writes) can finish cleanly.
 */
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { pool } from "./db/pool";
import { redis } from "./lib/redis";
import { closeQueues } from "./jobs/queues";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, tierB: env.FEATURE_TIER_B_ENABLED },
    "api listening"
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await Promise.allSettled([closeQueues(), pool.end(), redis.quit()]);
    logger.info("shutdown complete");
    process.exit(0);
  });
  // Hard exit if graceful close hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
