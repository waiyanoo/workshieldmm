import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { authLimiter } from "../../middleware/rateLimit";
import { confirmMfa, login, logout, refresh, startMfaSetup } from "./auth.service";
import { loginSchema, logoutSchema, mfaVerifySchema, refreshSchema } from "./auth.schemas";

export const authRouter = Router();

authRouter.post(
  "/login",
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await login({
      email: req.body.email,
      password: req.body.password,
      mfaCode: req.body.mfaCode,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

authRouter.post(
  "/refresh",
  authLimiter,
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const result = await refresh({
      refreshToken: req.body.refreshToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

authRouter.post(
  "/logout",
  validateBody(logoutSchema),
  asyncHandler(async (req, res) => {
    await logout(req.body.refreshToken);
    res.status(204).end();
  })
);

authRouter.post(
  "/mfa/setup",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await startMfaSetup(req.user!);
    res.json(result);
  })
);

authRouter.post(
  "/mfa/verify",
  requireAuth,
  validateBody(mfaVerifySchema),
  asyncHandler(async (req, res) => {
    const result = await confirmMfa(req.user!, req.body.code);
    res.json(result);
  })
);
