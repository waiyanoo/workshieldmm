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
(function loadNearestEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
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
