import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const BOT_TOKEN = "123456:test-bot-token";

const env = { HDYHAU_SURVEY_ENABLED: true, JWT_SECRET, BOT_TOKEN };
vi.mock("../../config.js", () => ({ env }));

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  hdyhauFindUnique: vi.fn(),
  hdyhauUpsert: vi.fn(),
  validateInitData: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: h.userFindUnique },
    hdyhauResponse: { findUnique: h.hdyhauFindUnique, upsert: h.hdyhauUpsert },
  },
}));
vi.mock("../init-data.js", () => ({ validateInitData: h.validateInitData }));

const { hdyhauRouter } = await import("./hdyhau.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");
const { HDYHAU_ANSWERS, HDYHAU_PROMPT_VERSION } = await import("@gennety/shared");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/hdyhau", (req, res, next) => {
    if (!env.HDYHAU_SURVEY_ENABLED) {
      res.status(404).json({ error: "hdyhau-disabled" });
      return;
    }
    hdyhauRouter(req, res, next);
  });
  return app;
}

function token(sub: string): string {
  return jwt.sign({ sub, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
}

const JWT_AUTH = () => ({ Authorization: `Bearer ${token(USER_ID)}` });
const TMA_AUTH = { Authorization: "tma user=stub&hash=stub" };

beforeEach(() => {
  vi.clearAllMocks();
  env.HDYHAU_SURVEY_ENABLED = true;
  h.userFindUnique.mockResolvedValue({ id: USER_ID, language: "en" });
  h.hdyhauFindUnique.mockResolvedValue(null);
  h.hdyhauUpsert.mockResolvedValue({});
  h.validateInitData.mockReturnValue({ valid: true, user: { id: 42 } });
});

describe("гейт фичи", () => {
  it("выключенный опрос отвечает 404, а не 403 — и до авторизации", async () => {
    env.HDYHAU_SURVEY_ENABLED = false;
    const res = await request(buildApp()).get("/v1/hdyhau");
    expect(res.status).toBe(404);
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });
});

describe("авторизация", () => {
  it("без учётных данных — 401", async () => {
    const res = await request(buildApp()).get("/v1/hdyhau");
    expect(res.status).toBe(401);
  });

  it("протухший JWT — 401", async () => {
    const stale = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: "-1m",
    });
    const res = await request(buildApp())
      .get("/v1/hdyhau")
      .set({ Authorization: `Bearer ${stale}` });
    expect(res.status).toBe(401);
  });

  it("битый initData — 401", async () => {
    h.validateInitData.mockReturnValue({ valid: false, reason: "bad-hash" });
    const res = await request(buildApp()).get("/v1/hdyhau").set(TMA_AUTH);
    expect(res.status).toBe(401);
  });

  it("обе поверхности приходят в одну ручку", async () => {
    const viaJwt = await request(buildApp()).get("/v1/hdyhau").set(JWT_AUTH());
    const viaTma = await request(buildApp()).get("/v1/hdyhau").set(TMA_AUTH);
    expect(viaJwt.status).toBe(200);
    expect(viaTma.status).toBe(200);
    expect(viaJwt.body.options).toEqual(viaTma.body.options);
  });
});

describe("вопрос", () => {
  it("отдаёт весь закрытый перечень с подписями и версией", async () => {
    const res = await request(buildApp()).get("/v1/hdyhau").set(JWT_AUTH());
    expect(res.body.version).toBe(HDYHAU_PROMPT_VERSION);
    expect(res.body.options.map((o: { value: string }) => o.value)).toEqual([
      ...HDYHAU_ANSWERS,
    ]);
    for (const option of res.body.options) {
      expect(typeof option.label).toBe("string");
      expect(option.label.length).toBeGreaterThan(0);
    }
    expect(res.body.answered).toBeNull();
  });

  it("говорит клиенту, что ответ уже дан — вопрос задаётся один раз", async () => {
    h.hdyhauFindUnique.mockResolvedValue({ answer: "friend_in_person" });
    const res = await request(buildApp()).get("/v1/hdyhau").set(JWT_AUTH());
    expect(res.body.answered).toBe("friend_in_person");
  });
});

describe("сохранение ответа", () => {
  it("принимает вариант из перечня и пишет версию формулировки", async () => {
    const res = await request(buildApp())
      .post("/v1/hdyhau")
      .set(JWT_AUTH())
      .send({ answer: "friend_in_person" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, answer: "friend_in_person", created: true });
    const call = h.hdyhauUpsert.mock.calls[0][0];
    expect(call.create).toMatchObject({
      userId: USER_ID,
      answer: "friend_in_person",
      promptVersion: HDYHAU_PROMPT_VERSION,
      surface: "ios",
    });
  });

  it("отвергает вариант не из перечня — свободному тексту сюда нельзя", async () => {
    for (const bad of ["мой друг Петя", "", "FRIEND_IN_PERSON", "<script>"]) {
      const res = await request(buildApp())
        .post("/v1/hdyhau")
        .set(JWT_AUTH())
        .send({ answer: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid-answer");
    }
    expect(h.hdyhauUpsert).not.toHaveBeenCalled();
  });

  it("поверхность берётся из способа авторизации, а не из тела", async () => {
    await request(buildApp())
      .post("/v1/hdyhau")
      .set(TMA_AUTH)
      // Клиент пытается назваться иначе — его не спрашивают.
      .send({ answer: "social_media", surface: "ios" });
    expect(h.hdyhauUpsert.mock.calls[0][0].create.surface).toBe("tg-mini");
  });

  it("повторная отправка обновляет ответ, а не заводит второй", async () => {
    h.hdyhauFindUnique.mockResolvedValue({ userId: USER_ID });
    const res = await request(buildApp())
      .post("/v1/hdyhau")
      .set(JWT_AUTH())
      .send({ answer: "search" });
    expect(res.body.created).toBe(false);
    expect(h.hdyhauUpsert.mock.calls[0][0].update).toMatchObject({ answer: "search" });
  });

  it("исчезнувший между авторизацией и записью пользователь — 404, а не 500", async () => {
    h.hdyhauUpsert.mockRejectedValue(new Error("foreign key violation"));
    const res = await request(buildApp())
      .post("/v1/hdyhau")
      .set(JWT_AUTH())
      .send({ answer: "ad" });
    expect(res.status).toBe(404);
  });
});
