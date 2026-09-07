import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { make } from "./rate-limit.js";

/**
 * Регрессия на дефект аудита 2026-09-06.
 *
 * Лимитер без явного `message` отвечал дефолтом `express-rate-limit` —
 * обычной строкой, — а Express 5 отдаёт строку как `text/html`. Клиент iOS
 * сгенерирован из OpenAPI, где 429 объявлен как `application/json`, и на
 * несовпадении content-type он БРОСАЕТ: ветка `.tooManyRequests`, которая
 * умеет сохранить пару токенов, не достигается, а `AuthSession` трактует
 * нечитаемый ответ как смерть сессии и чистит Keychain. То есть упереться в
 * ограничитель частоты означало вылететь на экран входа.
 *
 * Проверяется фабрика, а не конкретный лимитер: инвариант должен держаться
 * и для тех лимитеров, которых ещё нет.
 */
describe("rate limiter 429 contract", () => {
  function appWith(limiter: express.RequestHandler) {
    const app = express();
    app.use(limiter);
    app.get("/probe", (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it("отвечает JSON, когда у лимитера нет своего message", async () => {
    const app = appWith(make({ windowMs: 60_000, limit: 1 }));

    await request(app).get("/probe").expect(200);
    const limited = await request(app).get("/probe").expect(429);

    expect(limited.headers["content-type"]).toMatch(/application\/json/);
    expect(limited.body).toMatchObject({ error: expect.any(String) });
  });

  it("не ломает собственный message лимитера", async () => {
    const app = appWith(
      make({
        windowMs: 60_000,
        limit: 1,
        message: { error: "Too many OTP requests, try again later." },
      }),
    );

    await request(app).get("/probe").expect(200);
    const limited = await request(app).get("/probe").expect(429);

    expect(limited.headers["content-type"]).toMatch(/application\/json/);
    expect(limited.body).toEqual({ error: "Too many OTP requests, try again later." });
  });
});
