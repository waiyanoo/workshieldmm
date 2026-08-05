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
import { getFeatureSettings } from "./modules/admin/settings.service";

const app = createApp();

const server = app.listen(env.PORT, () => {
  void getFeatureSettings()
    .then((features) => logger.info({ port: env.PORT, env: env.NODE_ENV, ...features }, "api listening"))
    .catch((err) => logger.error({ err, port: env.PORT }, "api listening, but feature settings could not be read"));
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
