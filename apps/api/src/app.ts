/**
 * Express application assembly. Kept separate from the HTTP listener (index.ts)
 * so integration tests can import the app without binding a port.
 */
import express, { type Express } from "express";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger";
import { env } from "./config/env";
import { globalLimiter } from "./middleware/rateLimit";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { healthCheck } from "./db/pool";
import { authRouter } from "./modules/auth/auth.routes";
import { companiesRouter } from "./modules/companies/companies.routes";
import { verificationsRouter } from "./modules/verifications/verifications.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { creditsAdminRouter, creditsRouter } from "./modules/credits/credits.routes";
import { paymentsAdminRouter, paymentsRouter } from "./modules/payments/payments.routes";
import { profileRouter } from "./modules/profile/profile.routes";
import { teamRouter } from "./modules/team/team.routes";
import { accountsRouter } from "./modules/accounts/accounts.routes";
import { promotionsRouter } from "./modules/payments/promotions.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { categoriesAdminRouter } from "./modules/reports/categories-admin.routes";
import { requireTierB } from "./middleware/featureFlags";
import {
  accessRequestsRouter,
  categoriesRouter,
  reportsAdminRouter,
  reportsRouter,
} from "./modules/reports/reports.routes";
import { getFeatureSettings } from "./modules/admin/settings.service";

/**
 * Which browser origins may call this API.
 *
 * Requests with NO Origin header are allowed through: health checks from a load
 * balancer, curl, and server-to-server calls have no origin, and CORS is not a
 * control over those anyway — it only ever constrains what a browser will let
 * one page do to another. Blocking them would break readiness probes while
 * securing nothing.
 *
 * A disallowed origin is answered WITHOUT the access-control headers rather
 * than with an error. That is what the browser needs to refuse the response,
 * and it keeps the failure in the console of the offending page instead of
 * turning into a 500 in our logs.
 */
function corsOptions(): CorsOptions {
  const allowed = new Set(
    env.CORS_ORIGINS.length > 0
      ? env.CORS_ORIGINS
      : // Development convenience only. Production cannot reach this branch:
        // config/env refuses to boot without an explicit list.
        ["http://localhost:5173", "http://127.0.0.1:5173"]
  );
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      callback(null, allowed.has(origin.replace(/\/$/, "")));
    },
    // Bearer tokens in the Authorization header, never cookies — so the browser
    // has no credentials to withhold and enabling this would only widen things.
    credentials: false,
    // Preflight for JSON and multipart uploads carrying a bearer token.
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  };
}

export function createApp(): Express {
  const app = express();

  app.set("trust proxy", 1); // behind a load balancer in prod; real client IP for limits/audit
  app.use(helmet());
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));
  app.use(globalLimiter);

  // Liveness + readiness. Readiness fails if the DB is unreachable.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    const dbOk = await healthCheck();
    const features = dbOk
      ? await getFeatureSettings()
      : { tierB: env.FEATURE_TIER_B_ENABLED, teamInvites: env.FEATURE_TEAM_INVITES_ENABLED };
    res
      .status(dbOk ? 200 : 503)
      .json({
        status: dbOk ? "ready" : "degraded",
        db: dbOk,
        // The client reads these to decide what to put in the navigation, so a
        // disabled feature is absent rather than present-and-then-403.
        tierB: features.tierB,
        teamInvites: features.teamInvites,
      });
  });

  // Tier A + auth.
  app.use("/auth", authRouter);
  app.use("/companies", companiesRouter);
  app.use("/verifications", verificationsRouter);
  app.use("/admin", adminRouter);
  // Credits meter Tier A as well as Tier B, so they are not flag-gated. (Pricing §2)
  app.use("/credits", creditsRouter);
  app.use("/admin", creditsAdminRouter);
  app.use("/profile", profileRouter);
  // Team management. Two endpoints under here are public (invitation preview
  // and accept) because the invitee has no account yet — the router applies
  // requireAuth to everything after them.
  app.use("/team", teamRouter);
  // Account administration. Super Admin only — resetting a password or moving a
  // login email is the power to become another user.
  app.use("/admin", accountsRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/payments", paymentsRouter);
  app.use("/admin", paymentsAdminRouter);
  // Promotional pricing. Super Admin only — it sets what every company pays.
  app.use("/admin", promotionsRouter);
  // Policy must be configurable before Tier B is switched on, so this is not
  // feature-flagged with the employer report surfaces below.
  app.use("/admin", categoriesAdminRouter);

  // --- Tier B (conduct reports) — every router behind requireTierB, which is
  // off by default in ALL environments until the Phase 0 legal review is
  // complete. (§7)
  app.use("/report-categories", requireTierB, categoriesRouter);
  app.use("/reports", requireTierB, reportsRouter);
  app.use("/access-requests", requireTierB, accessRequestsRouter);
  app.use("/admin", requireTierB, reportsAdminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
