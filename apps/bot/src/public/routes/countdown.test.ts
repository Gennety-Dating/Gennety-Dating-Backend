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

const profileFindUnique = vi.fn(async (_args: unknown): Promise<unknown> => null);
vi.mock("@gennety/db", () => ({
  prisma: { profile: { findUnique: (args: unknown) => profileFindUnique(args) } },
}));

const countCitySearchers = vi.fn(async (_key: string | null | undefined): Promise<number | null> => null);
vi.mock("../../services/city-searchers.js", () => ({
  countCitySearchers: (key: string | null | undefined) => countCitySearchers(key),
}));

vi.mock("../../services/next-batch.js", () => ({
  getNextBatchDate: () => new Date("2026-09-10T15:00:00.000Z"),
}));

const resolveWeeklyStatusForUser = vi.fn(async (_id: string, _profile: unknown, _now: Date) => ({
  weeklyStatus: "standby",
  standbyCount: 2,
  priorityBoosted: false,
  resolvedAt: null as string | null,
}));
vi.mock("../../services/weekly-status.js", () => ({
  WEEKLY_STATUS_PROFILE_SELECT: { standbyCount: true, lastMissedAt: true },
  resolveWeeklyStatusForUser: (id: string, profile: unknown, now: Date) =>
    resolveWeeklyStatusForUser(id, profile, now),
}));

const resolveCalibration = vi.fn((_until: Date | null | undefined, _now: Date) => ({
  calibrating: false,
  firstDropAt: null as Date | null,
}));
vi.mock("../../services/first-drop-calibration.js", () => ({
  resolveCalibration: (until: Date | null | undefined, now: Date) => resolveCalibration(until, now),
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

const PROFILE = {
  standbyCount: 2,
  lastMissedAt: null,
  homeCityKey: "ua:kyiv",
  calibrationUntil: new Date("2026-09-11T10:00:00.000Z"),
};

beforeEach(() => {
  profileFindUnique.mockReset();
  profileFindUnique.mockResolvedValue(PROFILE);
  countCitySearchers.mockReset();
  countCitySearchers.mockResolvedValue(null);
  resolveWeeklyStatusForUser.mockClear();
  resolveCalibration.mockReset();
  resolveCalibration.mockReturnValue({ calibrating: false, firstDropAt: null });
});

describe("GET /v1/countdown — счётчик города", () => {
  it("город набрал порог — число уходит клиенту как есть", async () => {
    countCitySearchers.mockResolvedValue(2_341);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.searchersInCity).toBe(2_341);
    expect(countCitySearchers).toHaveBeenCalledWith("ua:kyiv");
  });

  it("город не выбран — ключ уходит пустым, и счётчик отвечает за это сам", async () => {
    profileFindUnique.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(200);
    expect(countCitySearchers).toHaveBeenCalledWith(undefined);
    expect(res.body).toHaveProperty("searchersInCity", null);
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

describe("GET /v1/countdown — одно чтение профиля на опрос", () => {
  it("читает профиль один раз и раздаёт строку всем трём частям ответа", async () => {
    countCitySearchers.mockResolvedValue(2_341);

    const res = await get();

    expect(profileFindUnique).toHaveBeenCalledTimes(1);
    expect(profileFindUnique).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      select: { standbyCount: true, lastMissedAt: true, homeCityKey: true, calibrationUntil: true },
    });
    expect(resolveWeeklyStatusForUser).toHaveBeenCalledWith(USER_ID, PROFILE, expect.any(Date));
    expect(resolveCalibration).toHaveBeenCalledWith(PROFILE.calibrationUntil, expect.any(Date));
    expect(res.body).toEqual({
      nextDropAt: "2026-09-10T15:00:00.000Z",
      serverNow: expect.any(String),
      weeklyStatus: "standby",
      standbyCount: 2,
      priorityBoosted: false,
      resolvedAt: null,
      searchersInCity: 2_341,
      searchPhase: "searching",
      firstDropAt: null,
    });
  });
});

describe("GET /v1/countdown — окно калибровки первой пары", () => {
  it("свежий аккаунт: фаза calibrating и время первого подбора", async () => {
    resolveCalibration.mockReturnValue({
      calibrating: true,
      firstDropAt: new Date("2026-09-11T15:00:00.000Z"),
    });

    const res = await get();

    expect(res.body.searchPhase).toBe("calibrating");
    expect(res.body.firstDropAt).toBe("2026-09-11T15:00:00.000Z");
  });

  it("обычный поиск: searching и firstDropAt = null", async () => {
    const res = await get();

    expect(res.body.searchPhase).toBe("searching");
    expect(res.body).toHaveProperty("firstDropAt", null);
  });
});
