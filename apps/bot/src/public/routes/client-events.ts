import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import { optionalAuth } from "../auth-middleware.js";
import { clientEventsLimiter } from "../rate-limit.js";
import { ingestClientEvents, CLIENT_EVENTS_MAX_BATCH } from "../../services/client-events.js";

/**
 * `POST /v1/client/events` — приём клиентской воронки нативного приложения
 * (iOS 6.2). Мотивация и закрытый перечень типов — в
 * `services/client-events.ts`.
 *
 * **JWT необязателен.** Половина событий, ради которых маршрут существует,
 * случается до того, как аккаунт заведён: уход с шага онбординга, отказ в
 * разрешении на уведомления, исход первой проверки живости. Требовать токен
 * значило бы не собирать именно их.
 *
 * **404 при выключенной фиче**, как у Premium-маршрутов, и гейт стоит ДО
 * авторизации: выключенный сбор не должен даже намекать, что тут что-то есть.
 * Дефолт флага — выключено, потому что privacy manifest приложения сейчас
 * заявляет, что аналитических данных мы не собираем.
 */
export const clientEventsRouter: Router = Router();

clientEventsRouter.use((_req: Request, res: Response, next): void => {
  if (!env.CLIENT_EVENTS_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});
clientEventsRouter.use(optionalAuth);

clientEventsRouter.post(
  "/events",
  clientEventsLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const result = await ingestClientEvents(req.body ?? {}, req.userId ?? null);

    if (result.status === "invalid") {
      res.status(400).json(
        result.reason === "too_many_events"
          ? { error: `At most ${CLIENT_EVENTS_MAX_BATCH} events per batch`, code: "too_many_events" }
          : { error: "Malformed batch" },
      );
      return;
    }

    res.json({ ok: true, accepted: result.accepted, dropped: result.dropped });
  },
);
