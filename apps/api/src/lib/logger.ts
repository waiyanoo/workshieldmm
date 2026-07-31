/**
 * Structured application logger (pino).
 *
 * This is OPERATIONAL logging only. It is deliberately separate from the audit
 * log (audit.audit_logs), so operational monitoring never becomes a second
 * copy of sensitive data. (§6 Monitoring, §5 Audit)
 *
 * Sensitive fields are redacted defensively — tokens, passwords, evidence, and
 * subject identifiers must never land in application logs.
 */
import { pino } from "pino";
import { env, isProd } from "../config/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.password_hash",
      "*.token",
      "*.refresh_token",
      "*.mfa_secret",
      "*.national_id",
      "*.national_id_hash",
      "*.evidence",
    ],
    censor: "[redacted]",
  },
  transport: isProd
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
});

export type Logger = typeof logger;
