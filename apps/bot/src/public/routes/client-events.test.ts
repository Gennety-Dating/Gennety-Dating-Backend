import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { IngestResult } from "../../services/client-events.js";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = { CLIENT_EVENTS_ENABLED: true, JWT_SECRET };
vi.mock("../../config.js", () => ({ env }));

// Мок повторяет НАСТОЯЩУЮ сигнатуру, а не берёт нулевую арность: второй
// аргумент — это userId, и три теста ниже проверяют именно его.
const ingestClientEvents = vi.fn(
  async (_batch: unknown, _userId: string | null): Promise<IngestResult> => ({
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
});
