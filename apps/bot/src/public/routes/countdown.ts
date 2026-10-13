import { Router, type Request, type Response } from "express";
import { prisma, type Prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { getNextBatchDate } from "../../services/next-batch.js";
import {
  resolveWeeklyStatusForUser,
  WEEKLY_STATUS_PROFILE_SELECT,
} from "../../services/weekly-status.js";
import { countCitySearchers } from "../../services/city-searchers.js";
import { resolveCalibration } from "../../services/first-drop-calibration.js";

export const countdownRouter: Router = Router();

countdownRouter.use(requireAuth);

/**
 * Every profile column this route answers from, read once per poll. The weekly
 * status, the city counter and the calibration window used to read the same row
 * three times over (four queries, one of them through `users`).
 */
const COUNTDOWN_PROFILE_SELECT = {
  ...WEEKLY_STATUS_PROFILE_SELECT,
  homeCityKey: true,
  calibrationUntil: true,
} as const satisfies Prisma.ProfileSelect;

/**
 * Next scheduled drop + server clock for skew correction. The mobile app
 * uses `serverNow` to align its timer with the server: daily at 18:00
 * Europe/Kyiv in production (`DROP_CADENCE=daily` since 2026-08-10).
 * Without the env override the code defaults to `weekly` (Thursday 18:00);
 * MATCH_CRON_SCHEDULE can override the active profile cron.
 *
 * `searchersInCity` едет здесь, а не в `/v1/app/config`: конфиг не
 * авторизован (город спрашивающего ему неизвестен) и кэшируется, а «Сегодня»
 * этот маршрут и так опрашивает. `null` значит «показывать нечего» — либо
 * город ещё не набрал порог, либо он у пользователя не выбран; отличать эти
 * два случая клиенту незачем, оба рисуются одинаково.
 *
 * `searchPhase` / `firstDropAt` — окно калибровки первой пары: свежий аккаунт
 * пропускает ближайший вечерний подбор, пока агент изучает профиль и город.
 * Это настоящий простой в отборе, а не декорация, поэтому статус «ищу» честен.
 */
countdownRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const userId = req.userId!;
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: COUNTDOWN_PROFILE_SELECT,
  });
  const [weekly, searchersInCity] = await Promise.all([
    resolveWeeklyStatusForUser(userId, profile, now),
    countCitySearchers(profile?.homeCityKey),
  ]);
  const calibration = resolveCalibration(profile?.calibrationUntil, now);
  res.json({
    nextDropAt: getNextBatchDate(now).toISOString(),
    serverNow: now.toISOString(),
    weeklyStatus: weekly.weeklyStatus,
    standbyCount: weekly.standbyCount,
    priorityBoosted: weekly.priorityBoosted,
    resolvedAt: weekly.resolvedAt,
    searchersInCity,
    // First-drop calibration (2026-10-11): `calibrating` while a fresh account
    // sits out the nearest batch; `firstDropAt` is the first batch it joins.
    searchPhase: calibration.calibrating ? "calibrating" : "searching",
    firstDropAt: calibration.firstDropAt?.toISOString() ?? null,
  });
});
