import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import {
  applyNotificationSettings,
  getNotificationSettings,
  parseNotificationSettingsPatch,
} from "../../services/notification-settings.js";

/**
 * `GET/PATCH /v1/me/notifications` — the person's switches for what Gennety
 * sends on its own (agent concept phase 4, founder 2026-11-26). The Telegram
 * Settings menu writes the same columns through the same service.
 */
export function createNotificationSettingsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    res.json(await getNotificationSettings(req.userId!));
  });

  router.patch("/", async (req: Request, res: Response): Promise<void> => {
    const parsed = parseNotificationSettingsPatch(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await applyNotificationSettings(req.userId!, parsed.patch);
    res.json(await getNotificationSettings(req.userId!));
  });

  return router;
}
