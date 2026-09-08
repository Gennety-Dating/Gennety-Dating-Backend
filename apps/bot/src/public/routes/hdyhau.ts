import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { verifyAccessToken } from "../jwt.js";
import {
  buildHdyhauPrompt,
  loadHdyhauResponse,
  saveHdyhauResponse,
} from "../../services/hdyhau.js";

/**
 * Опрос «откуда вы про нас узнали» (HDYHAU) — `/v1/hdyhau`.
 *
 *   GET  /v1/hdyhau  — вопрос, варианты на языке пользователя и уже данный ответ
 *   POST /v1/hdyhau  — сохранить ответ (идемпотентно, один на пользователя)
 *
 * **404 при выключенной фиче**, и гейт стоит ДО авторизации — та же схема, что
 * у `/v1/client/events`: выключенный опрос не должен даже намекать, что тут
 * что-то есть. Дефолт флага — выключено, потому что МЕСТО вопроса в онбординге
 * — продуктовое решение, а не техническое (`AGENTS.md`, правило 5), и включать
 * сбор раньше, чем это решение принято, значит принять его молча.
 *
 * **Две авторизации, одна ручка.** Mini App приходит с `Authorization: tma
 * <initData>`, нативный клиент — с `Bearer <JWT>`. Разводить их по двум
 * маршрутам значило бы иметь два набора вариантов ответа, которые однажды
 * разъедутся, и получить распределение, которое ни на что не сводится.
 *
 * Свободного текста здесь нет: `answer` проверяется по закрытому перечню в
 * `shared/hdyhau.ts`, поэтому в аналитическую таблицу физически не попадает ни
 * имя, ни ссылка, ни что-либо ещё, что человек мог бы вписать руками.
 */
export const hdyhauRouter: Router = Router();

type Caller =
  | { ok: true; userId: string; lang: Language; surface: "tg-mini" | "ios" }
  | { ok: false; status: number; error: string };

/**
 * Разобрать вызывающего: сначала Mini App (initData), потом нативный JWT.
 * Порядок неважен — заголовки взаимоисключающие по префиксу.
 */
async function authenticate(req: Request): Promise<Caller> {
  const header = req.header("authorization") ?? req.header("Authorization") ?? "";

  if (header.startsWith("tma ")) {
    const initData = header.slice(4).trim();
    if (!initData) return { ok: false, status: 401, error: "Empty initData" };
    const validation = validateInitData(initData, env.BOT_TOKEN);
    if (!validation.valid) return { ok: false, status: 401, error: "Invalid initData" };
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(validation.user.id) },
      select: { id: true, language: true },
    });
    if (!user) return { ok: false, status: 404, error: "user-not-found" };
    return {
      ok: true,
      userId: user.id,
      lang: (user.language ?? "en") as Language,
      surface: "tg-mini",
    };
  }

  if (header.startsWith("Bearer ")) {
    let userId: string;
    try {
      userId = verifyAccessToken(header.slice(7)).sub;
    } catch {
      return { ok: false, status: 401, error: "Invalid or expired token" };
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, language: true },
    });
    if (!user) return { ok: false, status: 404, error: "user-not-found" };
    return {
      ok: true,
      userId: user.id,
      lang: (user.language ?? "en") as Language,
      surface: "ios",
    };
  }

  return { ok: false, status: 401, error: "Missing credentials" };
}

hdyhauRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const caller = await authenticate(req);
  if (!caller.ok) {
    res.status(caller.status).json({ error: caller.error });
    return;
  }

  const answered = await loadHdyhauResponse(caller.userId);
  res.status(200).json({
    ok: true,
    ...buildHdyhauPrompt(caller.lang),
    // Клиент обязан знать, спрашивали ли уже: вопрос задаётся один раз, и
    // повторный показ читается как «мой ответ не сохранился».
    answered,
  });
});

hdyhauRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const caller = await authenticate(req);
  if (!caller.ok) {
    res.status(caller.status).json({ error: caller.error });
    return;
  }

  const body = (req.body ?? {}) as { answer?: unknown };
  const result = await saveHdyhauResponse({
    userId: caller.userId,
    answer: body.answer,
    // Поверхность определяется способом авторизации, а не телом запроса:
    // иначе клиент мог бы назваться любым, и разрез «где спрашивали» перестал
    // бы что-либо значить.
    surface: caller.surface,
  });

  if (result.status === "invalid") {
    res.status(400).json({ error: `invalid-${result.reason}` });
    return;
  }
  if (result.status === "unknown-user") {
    res.status(404).json({ error: "user-not-found" });
    return;
  }

  res.status(200).json({ ok: true, answer: result.answer, created: result.created });
});
