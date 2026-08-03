import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { authLimiter } from "../../middleware/rateLimit";
import { changeOwnPassword, confirmMfa, login, logout, refresh, startMfaSetup } from "./auth.service";
import { changePasswordSchema, loginSchema, logoutSchema, mfaVerifySchema, refreshSchema } from "./auth.schemas";

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

// Replace your own password. Reachable while a temporary password is
// outstanding — it is the only thing that is. (middleware/auth.ts)
authRouter.post(
  "/change-password",
  authLimiter,
  requireAuth,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await changeOwnPassword(req.user!, {
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      })
    );
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
    const result = await confirmMfa(req.user!, req.body.code, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);
