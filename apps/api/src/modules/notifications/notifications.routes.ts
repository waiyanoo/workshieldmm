/**
 * Notification routes. Company users only — platform staff have the admin
 * queues, which are their equivalent.
 */
import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { listNotifications, markAllRead, markRead } from "./notifications.service";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.use(requireRole("company_admin", "company_user"));

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listNotifications(req.user!));
  })
);

notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    res.json(await markAllRead(req.user!));
  })
);

// Registered after /read-all so the literal path is not swallowed by :id.
notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    res.json(await markRead(req.user!, req.params.id!));
  })
);
