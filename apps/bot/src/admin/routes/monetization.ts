import { Router, type Request, type Response } from "express";
import { getOrCompute } from "../utils/cache.js";
import { loadMonetizationSummary } from "../utils/monetization-source.js";

/**
 * `GET /admin/analytics/monetization` — сколько из привлечённых пользователей
 * платят.
 *
 * Отличие от `/admin/purchases`, с которым его легко перепутать: тот —
 * ЛЕДЖЕР (какие платежи прошли, кто заплатил, сколько), а этот — КОНВЕРСИЯ
 * (какая доля людей платит и какая доля из какого сегмента). У леджера нет
 * знаменателя, у этого эндпоинта нет отдельных транзакций.
 *
 * Отсюда же два намеренно разных решения по кэшу: леджер НЕ кэшируется,
 * потому что фаундер идёт туда проверить, прошёл ли конкретный платёж, и
 * десятиминутный ответ там хуже, чем никакого. Здесь — обычный
 * аналитический кэш на 15 минут с `?fresh=1`, как у остальных вкладок:
 * конверсия не меняется от одного платежа настолько, чтобы это стоило
 * двух сканов базы на каждое открытие вкладки.
 *
 * Правила подсчёта (кто считается платящим, почему тестовые аккаунты вне
 * дроби, что такое «дошёл до платного экрана») живут в
 * `admin/utils/monetization.ts` — там же, где их проверяют тесты.
 */
export const monetizationRouter: Router = Router();

monetizationRouter.get(
  "/admin/analytics/monetization",
  async (req: Request, res: Response) => {
    try {
      const data = await getOrCompute(
        "monetization:v1",
        900,
        async () => loadMonetizationSummary(),
        { req, res },
      );
      res.json(data);
    } catch (err) {
      console.error("[admin] monetization error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
