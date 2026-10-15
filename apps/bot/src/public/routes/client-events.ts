import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import { optionalAuth } from "../auth-middleware.js";
import { clientEventsIpLimiter, clientEventsLimiter } from "../rate-limit.js";
import { ingestClientEvents, CLIENT_EVENTS_MAX_BATCH } from "../../services/client-events.js";
import { analyticsConsentOf, userIdByTelegramId } from "../../services/analytics-consent.js";
import { validateInitData } from "../init-data.js";

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
 * Дефолт флага — выключено; включается на выкате Pulse вместе с миграцией
 * `20261015120000_pulse_analytics` (согласие `analytics_opt_in` должно
 * существовать раньше, чем первый батч до него дойдёт).
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

/**
 * Mini App (Pulse, контракт v2) шлёт сюда же, но подписью Telegram:
 * `Authorization: tma <initData>`. Битая подпись — не 401, а аноним, по той же
 * причине, что у протухшего JWT в `optionalAuth`: ронять сбор незачем, а
 * анонимный батч ни к кому не привяжется. Сама платформа батча под `tma`
 * назначается принудительно — заявление тела тут ничего не решает.
 */
async function miniAppUserId(req: Request): Promise<string | null | undefined> {
  const header = req.headers.authorization;
  if (!header?.startsWith("tma ")) return undefined;
  const validation = validateInitData(header.slice(4).trim(), env.BOT_TOKEN);
  if (!validation.valid) return null;
  return userIdByTelegramId(validation.user.id);
}

clientEventsRouter.post(
  "/events",
  // Адресный потолок стоит ПЕРВЫМ: ключ следующего лимитера читается из тела,
  // то есть выбирается вызывающим, и ротация значения обходила бы его.
  clientEventsIpLimiter,
  clientEventsLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const miniApp = await miniAppUserId(req);
    const userId = miniApp === undefined ? (req.userId ?? null) : miniApp;

    // Согласие проверяет сервер, а не только клиент (спека §2.4): опознанный
    // человек без галочки не оставляет здесь ни строки, какой бы клиент ни
    // прислал батч. Неопознанный батч — ответственность клиента, который до
    // решения держит события только в памяти.
    if (userId) {
      const consent = await analyticsConsentOf(userId);
      if (consent !== true) {
        const events = (req.body as { events?: unknown } | undefined)?.events;
        const dropped = Array.isArray(events) ? events.length : 0;
        res.json({ ok: true, accepted: 0, dropped, consent: false });
        return;
      }
    }

    const result = await ingestClientEvents(
      req.body ?? {},
      userId,
      miniApp === undefined ? {} : { platform: "miniapp" },
    );

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
