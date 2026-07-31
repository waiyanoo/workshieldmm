/**
 * Shared Redis connection — backs rate limiting now, and BullMQ job queues
 * (expiry, notifications, retention purges) as those land. (§2 Background jobs)
 */
import { Redis } from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on("error", (err) => {
  // Don't crash the process on a transient Redis blip; log and let commands retry.
  logger.warn({ err: err.message }, "redis connection error");
});
