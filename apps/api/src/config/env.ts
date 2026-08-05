/**
 * Validated environment configuration.
 *
 * Nothing else in the app reads process.env directly — everything goes through
 * this typed, validated object so a missing or malformed variable fails fast at
 * boot rather than at the first request. Secrets themselves come from a vault
 * in production (§5); this only validates their shape.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// The API runs from apps/api (npm workspace cwd), but the single source-of-truth
// .env lives at the repo root. Walk up from cwd to the nearest .env so both
// `npm run dev` and `npm run migrate -w @hyper/api` load the same config.
//
// Under NODE_ENV=test, .env.test is loaded FIRST and .env second. dotenv never
// overwrites a variable that is already set, so .env.test wins where it speaks
// and .env fills in the rest — which is why .env.test only needs to name the
// handful of things tests must not share with development (its own database,
// its own Redis keyspace).
(function loadNearestEnv() {
  const names = process.env.NODE_ENV === "test" ? [".env.test", ".env"] : [".env"];
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
  loadDotenv(); // fall back to default behavior
})();

const boolish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATION_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolish.default("true"),

  // Server-side encryption for evidence and identity documents (§5: AES-256 at
  // rest). Local MinIO has no KMS, so dev defaults to 'none'; production must
  // set one — enforced below, not left to a deploy checklist.
  S3_SSE: z.enum(["none", "AES256", "aws:kms"]).default("none"),
  S3_SSE_KMS_KEY_ID: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1_209_600),

  SUBJECT_ID_PEPPER: z.string().min(16),

  // Tier B stays off unless explicitly enabled. Off in every env by default. (§7)
  FEATURE_TIER_B_ENABLED: boolish.default("false"),

  // Team invitations. Off by default: there is no email transport, so an
  // invitation is a link an administrator copies and sends by some channel of
  // their own — fine for a pilot, not something to expose to every customer
  // before that is a deliberate decision. Turning it on is one env var.
  FEATURE_TEAM_INVITES_ENABLED: boolish.default("false"),

  REPORT_EXPIRY_YEARS: z.coerce.number().int().min(1).max(10).default(5),

  /**
   * Browser origins allowed to call this API, comma-separated.
   *
   * Required in production. The API is bearer-token rather than cookie
   * authenticated, so a permissive policy is not the same hole it would be for
   * a session-cookie app — but it still lets any page on the internet script
   * this API against a token it has obtained, and it means a misconfigured
   * deployment looks healthy right up until it is abused. An explicit list also
   * fails loudly when someone stands up a new front end and forgets to say so.
   *
   * Development defaults to the Vite dev server.
   */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((o) => o.trim().replace(/\/$/, ""))
        .filter(Boolean)
    ),
})
  .superRefine((cfg, ctx) => {
    // Evidence at rest is unencrypted unless a mode is set, and §5 requires
    // AES-256. Refuse to boot a production node without it rather than shipping
    // misconduct evidence to a plaintext bucket.
    if (cfg.NODE_ENV === "production" && cfg.S3_SSE === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_SSE"],
        message: "must be AES256 or aws:kms in production (§5 encryption at rest)",
      });
    }
    // A production API that accepts calls from anywhere is a configuration
    // mistake, not a deployment choice, so it refuses to boot rather than
    // running wide open.
    if (cfg.NODE_ENV === "production" && cfg.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message:
          "is required in production — comma-separated list of the web origins " +
          "allowed to call this API, e.g. https://app.example.com",
      });
    }
    if (cfg.S3_SSE === "aws:kms" && !cfg.S3_SSE_KMS_KEY_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_SSE_KMS_KEY_ID"],
        message: "is required when S3_SSE is aws:kms",
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loudly — never boot with an invalid config.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
