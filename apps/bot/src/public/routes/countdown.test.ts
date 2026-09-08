import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `GET /v1/countdown` и поле `searchersInCity`.
 *
 * Сам порог покрыт в `services/city-searchers.test.ts`. Здесь проверяется то,
 * что тот файл проверить не может: что маршрут вообще СПРАШИВАЕТ счётчик и
 * кладёт ответ в тело. Поле nullable, поэтому забытая проводка не роняет
 * ничего — она просто молча не доезжает до клиента, и заметить это можно было
 * бы только на живом городе, перешагнувшем порог.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = { JWT_SECRET };
vi.mock("../../config.js", () => ({ env }));

const countCitySearchers = vi.fn(async (_id: string): Promise<number | null> => null);
vi.mock("../../services/city-searchers.js", () => ({
  countCitySearchers: (id: string) => countCitySearchers(id),
}));

vi.mock("../../services/next-batch.js", () => ({
  getNextBatchDate: () => new Date("2026-09-10T15:00:00.000Z"),
}));

vi.mock("../../services/weekly-status.js", () => ({
  resolveWeeklyStatusForUser: async () => ({
    weeklyStatus: "standby",
    standbyCount: 2,
    priorityBoosted: false,
    resolvedAt: null,
  }),
}));

const { countdownRouter } = await import("./countdown.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function get() {
  const token = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
  const app = express();
  app.use(express.json());
  app.use("/v1/countdown", countdownRouter);
  return request(app).get("/v1/countdown").set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  countCitySearchers.mockReset();
  countCitySearchers.mockResolvedValue(null);
});

describe("GET /v1/countdown — счётчик города", () => {
  it("город набрал порог — число уходит клиенту как есть", async () => {
    countCitySearchers.mockResolvedValue(2_341);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.searchersInCity).toBe(2_341);
    expect(countCitySearchers).toHaveBeenCalledWith(USER_ID);
  });

  it("ниже порога — поле ПРИСУТСТВУЕТ и равно null, а не пропадает", async () => {
    countCitySearchers.mockResolvedValue(null);

    const res = await get();

    // Разница важна: отсутствующее поле клиент прочитал бы как «сервер старый»,
    // а null — как «показывать нечего». Контракт объявляет его required.
    expect(res.body).toHaveProperty("searchersInCity", null);
  });

  it("остальные поля ответа не пострадали", async () => {
    const res = await get();

    expect(res.body.weeklyStatus).toBe("standby");
    expect(res.body.standbyCount).toBe(2);
    expect(res.body.priorityBoosted).toBe(false);
    expect(typeof res.body.nextDropAt).toBe("string");
    expect(typeof res.body.serverNow).toBe("string");
  });
});
