import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { getNextBatchDate } from "../../services/next-batch.js";
import { resolveWeeklyStatusForUser } from "../../services/weekly-status.js";
import { countCitySearchers } from "../../services/city-searchers.js";

export const countdownRouter: Router = Router();

countdownRouter.use(requireAuth);

/**
 * Next weekly drop + server clock for skew correction. The mobile app
 * uses `serverNow` to align its client timer with the server (Thursday
 * 18:00 Europe/Kyiv by default, driven by MATCH_CRON_SCHEDULE).
 *
 * `searchersInCity` едет здесь, а не в `/v1/app/config`: конфиг не
 * авторизован (город спрашивающего ему неизвестен) и кэшируется, а «Сегодня»
 * этот маршрут и так опрашивает. `null` значит «показывать нечего» — либо
 * город ещё не набрал порог, либо он у пользователя не выбран; отличать эти
 * два случая клиенту незачем, оба рисуются одинаково.
 */
countdownRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const [weekly, searchersInCity] = await Promise.all([
    resolveWeeklyStatusForUser(req.userId!, now),
    countCitySearchers(req.userId!),
  ]);
  res.json({
    nextDropAt: getNextBatchDate(now).toISOString(),
    serverNow: now.toISOString(),
    weeklyStatus: weekly.weeklyStatus,
    standbyCount: weekly.standbyCount,
    priorityBoosted: weekly.priorityBoosted,
    resolvedAt: weekly.resolvedAt,
    searchersInCity,
  });
});
