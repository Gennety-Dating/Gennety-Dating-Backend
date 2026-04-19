import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { getNextBatchDate } from "../../services/next-batch.js";

export const countdownRouter: Router = Router();

countdownRouter.use(requireAuth);

/**
 * Next weekly drop + server clock for skew correction. The mobile app
 * uses `serverNow` to align its client timer with the server (Thursday
 * 18:00 Europe/Kyiv by default, driven by MATCH_CRON_SCHEDULE).
 */
countdownRouter.get("/", (_req: Request, res: Response): void => {
  const now = new Date();
  res.json({
    nextDropAt: getNextBatchDate(now).toISOString(),
    serverNow: now.toISOString(),
  });
});
