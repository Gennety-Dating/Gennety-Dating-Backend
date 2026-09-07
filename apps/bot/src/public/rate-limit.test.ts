import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { make, phoneKey } from "./rate-limit.js";

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

/**
 * Ключ, по которому лимитер считает.
 *
 * Оба дефекта аудита здесь одного рода: ключ строился на строке, которая
 * меняется без изменения того, что она называет. У телефона это
 * форматирование, у Mini App — `auth_date`/`hash`, которые Telegram
 * перевыпускает при каждом открытии окна. Ведро, которое сбрасывается
 * закрытием и открытием окна, ведром не является.
 */
describe("ключ телефонного лимитера", () => {
  function key(phone: string): string {
    return phoneKey({ body: { phone } } as never);
  }

  it("сводит разные записи одного номера в один ключ", () => {
    const canonical = key("+15551234567");
    expect(key("1 555 123 4567")).toBe(canonical);
    expect(key("+1 (555) 123-4567")).toBe(canonical);
    expect(key("+1-555-123-4567")).toBe(canonical);
  });

  it("не смешивает разные номера", () => {
    expect(key("+15551234567")).not.toBe(key("+15551234568"));
  });

  it("считает и то, что разобрать не удалось", () => {
    // Такой запрос всё равно откажут ниже по течению, но он обязан
    // засчитаться против чего-то, а не получить пустой ключ.
    expect(key("не телефон")).not.toBe("");
    expect(key("не телефон")).toBe(key("НЕ ТЕЛЕФОН"));
  });
});
