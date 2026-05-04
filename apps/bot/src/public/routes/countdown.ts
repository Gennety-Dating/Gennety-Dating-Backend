import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { getNextBatchDate } from "../../services/next-batch.js";
import { resolveWeeklyStatusForUser } from "../../services/weekly-status.js";

export const countdownRouter: Router = Router();

countdownRouter.use(requireAuth);

/**
 * Next weekly drop + server clock for skew correction. The mobile app
 * uses `serverNow` to align its client timer with the server (Thursday
 * 18:00 Europe/Kyiv by default, driven by MATCH_CRON_SCHEDULE).
 */
countdownRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const weekly = await resolveWeeklyStatusForUser(req.userId!, now);
  res.json({
    nextDropAt: getNextBatchDate(now).toISOString(),
    serverNow: now.toISOString(),
    weeklyStatus: weekly.weeklyStatus,
    standbyCount: weekly.standbyCount,
    priorityBoosted: weekly.priorityBoosted,
    resolvedAt: weekly.resolvedAt,
  });
});
