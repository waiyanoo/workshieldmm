/**
 * Rate limiting — a first-class compliance control here, not just abuse
 * protection: per-company limits on submissions and searches are what prevent
 * bulk blacklisting and bulk scraping of the database. (§5 Rate limiting)
 *
 * A factory so each surface (global, auth, per-company search/submit) gets its
 * own budget with a shared Redis store.
 */
import rateLimit, { type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../lib/redis";
import { tooManyRequests } from "../lib/errors";

export function makeLimiter(opts: {
  windowMs: number;
  limit: number;
  prefix: string;
  keyGenerator?: Options["keyGenerator"];
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator,
    store: new RedisStore({
      // ioredis `call` is variadic; rate-limit-redis hands us a command + args.
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<never>,
      prefix: `rl:${opts.prefix}:`,
    }),
    handler: (_req, _res, next) => next(tooManyRequests()),
  });
}

/** Coarse global limiter applied to all traffic as a backstop. */
export const globalLimiter = makeLimiter({
  windowMs: 60_000,
  limit: 300,
  prefix: "global",
});

/** Stricter limiter for credential endpoints to blunt brute-force attempts. */
export const authLimiter = makeLimiter({
  windowMs: 15 * 60_000,
  limit: 20,
  prefix: "auth",
});

/**
 * Per-company limiter for Tier A verification submissions. Keyed by the
 * authenticated company so one employer can't exhaust another's budget — this
 * is the "prevents bulk ... scraping" control from §5, scoped to the tenant.
 */
export const verificationLimiter = makeLimiter({
  windowMs: 60_000,
  limit: 30,
  prefix: "verify",
  keyGenerator: (req) => req.user?.companyId ?? req.ip ?? "anon",
});

/**
 * Tier B limits (§5: per-company limits on BOTH report submissions and
 * search/access requests — prevents bulk blacklisting and bulk scraping).
 */
export const reportSubmissionLimiter = makeLimiter({
  windowMs: 60 * 60_000,
  limit: 10, // deliberately tight: volume is the wrong incentive here
  prefix: "report",
  keyGenerator: (req) => req.user?.companyId ?? req.ip ?? "anon",
});

export const accessSearchLimiter = makeLimiter({
  windowMs: 60_000,
  limit: 10,
  prefix: "access",
  keyGenerator: (req) => req.user?.companyId ?? req.ip ?? "anon",
});
