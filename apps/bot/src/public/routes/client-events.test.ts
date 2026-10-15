import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { IngestResult } from "../../services/client-events.js";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = { CLIENT_EVENTS_ENABLED: true, JWT_SECRET, BOT_TOKEN: "bot-token" };
vi.mock("../../config.js", () => ({ env }));

// Мок повторяет НАСТОЯЩУЮ сигнатуру, а не берёт нулевую арность: второй
// аргумент — это userId, и три теста ниже проверяют именно его.
const ingestClientEvents = vi.fn(
  async (
    _batch: unknown,
    _userId: string | null,
    _options?: { platform?: "ios" | "miniapp" },
  ): Promise<IngestResult> => ({
    status: "ok",
    accepted: 1,
    dropped: 0,
  }),
);
vi.mock("../../services/client-events.js", () => ({
  ingestClientEvents: (...args: Parameters<typeof ingestClientEvents>) =>
    ingestClientEvents(...args),
  CLIENT_EVENTS_MAX_BATCH: 200,
}));

// Согласие и Telegram-опознание — отдельный сервис; по умолчанию согласие
// дано, чтобы старые тесты проверяли ровно то, что проверяли до Pulse.
const analyticsConsentOf = vi.fn(async (_userId: string): Promise<boolean | null> => true);
const userIdByTelegramId = vi.fn(async (_tg: number): Promise<string | null> => USER_ID);
vi.mock("../../services/analytics-consent.js", () => ({
  analyticsConsentOf: (id: string) => analyticsConsentOf(id),
  userIdByTelegramId: (tg: number) => userIdByTelegramId(tg),
}));
const validateInitData = vi.fn((_initData: string, _token: string) => ({
  valid: true as const,
  user: { id: 777 },
}));
vi.mock("../init-data.js", () => ({
  validateInitData: (data: string, botToken: string) => validateInitData(data, botToken),
}));

const { clientEventsRouter } = await import("./client-events.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/client", clientEventsRouter);
  return app;
}

function token(sub: string): string {
  // Тот же issuer/audience, что проверяет `verifyAccessToken`, — иначе токен
  // валиден по подписи и отвергнут по заявкам.
  return jwt.sign({ sub, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
}

const BODY = { installId: "install-1", events: [] };

beforeEach(() => {
  env.CLIENT_EVENTS_ENABLED = true;
  ingestClientEvents.mockClear();
  ingestClientEvents.mockResolvedValue({ status: "ok", accepted: 1, dropped: 0 });
  analyticsConsentOf.mockClear();
  analyticsConsentOf.mockResolvedValue(true);
  userIdByTelegramId.mockClear();
  validateInitData.mockClear();
});

describe("POST /v1/client/events", () => {
  it("отвечает 200 и не требует токена — половина воронки случается до логина", async () => {
    const res = await request(buildApp()).post("/v1/client/events").send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, dropped: 0 });
    // Второй аргумент — userId; без токена он null, а не отказ.
    expect(ingestClientEvents.mock.calls[0]?.[1]).toBeNull();
  });

  it("подхватывает userId, когда токен всё-таки есть", async () => {
    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", `Bearer ${token(USER_ID)}`)
      .send(BODY);

    expect(res.status).toBe(200);
    expect(ingestClientEvents.mock.calls[0]?.[1]).toBe(USER_ID);
  });

  it("протухший или битый токен оставляет человека анонимным, а не роняет запрос", async () => {
    // Ронять сбор телеметрии из-за истёкшего access-токена незачем: событие
    // уже случилось, и выбросить его дороже, чем записать без userId.
    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", "Bearer not-a-token")
      .send(BODY);

    expect(res.status).toBe(200);
    expect(ingestClientEvents.mock.calls[0]?.[1]).toBeNull();
  });

  it("при выключенной фиче отвечает 404 и до сервиса не доходит", async () => {
    env.CLIENT_EVENTS_ENABLED = false;

    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", `Bearer ${token(USER_ID)}`)
      .send(BODY);

    expect(res.status).toBe(404);
    expect(ingestClientEvents).not.toHaveBeenCalled();
  });

  it("битое тело — 400", async () => {
    ingestClientEvents.mockResolvedValue({ status: "invalid", reason: "malformed" });

    const res = await request(buildApp()).post("/v1/client/events").send({ nope: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Malformed batch");
  });

  it("слишком длинный батч — 400 с машинным кодом", async () => {
    ingestClientEvents.mockResolvedValue({ status: "invalid", reason: "too_many_events" });

    const res = await request(buildApp()).post("/v1/client/events").send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("too_many_events");
  });


  it("опознанный человек без согласия не оставляет ни строки — сервер не верит клиенту на слово", async () => {
    analyticsConsentOf.mockResolvedValue(false);

    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", `Bearer ${token(USER_ID)}`)
      .send({ installId: "install-1", events: [{}, {}, {}] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 0, dropped: 3, consent: false });
    expect(ingestClientEvents).not.toHaveBeenCalled();
  });

  it("удалённый между токеном и запросом человек — тоже без записи", async () => {
    analyticsConsentOf.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", `Bearer ${token(USER_ID)}`)
      .send(BODY);

    expect(res.body.consent).toBe(false);
    expect(ingestClientEvents).not.toHaveBeenCalled();
  });

  it("Mini App: подпись tma опознаёт человека и платформа назначается принудительно", async () => {
    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", "tma query_id=1&hash=abc")
      .send({ ...BODY, platform: "ios" });

    expect(res.status).toBe(200);
    expect(userIdByTelegramId).toHaveBeenCalledWith(777);
    expect(ingestClientEvents.mock.calls[0]?.[1]).toBe(USER_ID);
    expect(ingestClientEvents.mock.calls[0]?.[2]).toEqual({ platform: "miniapp" });
  });

  it("Mini App: битая подпись — аноним, а не 401", async () => {
    validateInitData.mockReturnValueOnce({ valid: false, reason: "bad-hash" } as never);

    const res = await request(buildApp())
      .post("/v1/client/events")
      .set("Authorization", "tma broken")
      .send(BODY);

    expect(res.status).toBe(200);
    expect(ingestClientEvents.mock.calls[0]?.[1]).toBeNull();
    expect(analyticsConsentOf).not.toHaveBeenCalled();
  });

  // Последним: лимитер живёт на уровне модуля, и исчерпанный бюджет адреса
  // отвечал бы 429 всем тестам после этого.
  /**
   * `installId` приходит в ТЕЛЕ и потому подконтролен вызывающему: пока он был
   * единственным ключом лимитера, новое значение в каждом запросе означало
   * новый бюджет, то есть анонимная запись в БД не ограничивалась ничем, кроме
   * глобального пола. Ротация должна упираться в потолок на адрес.
   */
  it("ротация installId не даёт нового бюджета — потолок на адрес держит", async () => {
    const app = buildApp();
    const statuses: number[] = [];

    for (let i = 0; i < 40; i += 1) {
      const res = await request(app)
        .post("/v1/client/events")
        .send({ installId: `rotated-${i}`, events: [] });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });
});
