import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route's own job is narrow: refuse politely when the feature is not
 * configured, map each verification failure to a status the client can act on,
 * and never mint a session for a token the verifier did not accept.
 *
 * Signature verification itself is covered by
 * `services/telegram-login.test.ts`, which signs real tokens.
 */

const envMock = { TELEGRAM_LOGIN_CLIENT_ID: "8707759133" };
vi.mock("../config.js", () => ({ env: envMock }));

const verifyTelegramIdToken = vi.fn();
vi.mock("../services/telegram-login.js", () => ({ verifyTelegramIdToken }));

const findOrCreateUserByTelegramLogin = vi.fn();
vi.mock("./mobile-user.js", () => ({ findOrCreateUserByTelegramLogin }));

vi.mock("./jwt.js", () => ({
  signAccessToken: vi.fn(() => "access-token"),
  createRefreshToken: vi.fn(async () => "refresh-token"),
  accessTokenTtlSeconds: vi.fn(() => 900),
}));

vi.mock("./routes/serializers.js", () => ({
  serializeUser: vi.fn((u: { id: string }) => ({ id: u.id })),
}));

const { telegramAuthRouter } = await import("./routes/telegram-auth.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/auth", telegramAuthRouter);
  return app;
}

const IDENTITY = { telegramId: 482533900n, phone: "+380972455081", username: "gleb" };

beforeEach(() => {
  envMock.TELEGRAM_LOGIN_CLIENT_ID = "8707759133";
  verifyTelegramIdToken.mockReset();
  findOrCreateUserByTelegramLogin.mockReset();
  verifyTelegramIdToken.mockResolvedValue({ ok: true, identity: IDENTITY });
  findOrCreateUserByTelegramLogin.mockResolvedValue({
    kind: "resolved",
    user: { id: "user-1" },
  });
});

describe("POST /v1/auth/telegram", () => {
  it("mints our session for a verified token", async () => {
    const res = await request(buildApp())
      .post("/v1/auth/telegram")
      .send({ idToken: "signed.id.token" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
      user: { id: "user-1" },
    });
    expect(findOrCreateUserByTelegramLogin).toHaveBeenCalledWith(IDENTITY);
  });

  it("503s while no Client ID is configured, without touching the verifier", async () => {
    envMock.TELEGRAM_LOGIN_CLIENT_ID = "";

    const res = await request(buildApp())
      .post("/v1/auth/telegram")
      .send({ idToken: "signed.id.token" });

    expect(res.status).toBe(503);
    expect(verifyTelegramIdToken).not.toHaveBeenCalled();
  });

  it("rejects a missing token before any work", async () => {
    const res = await request(buildApp()).post("/v1/auth/telegram").send({});

    expect(res.status).toBe(400);
    expect(verifyTelegramIdToken).not.toHaveBeenCalled();
  });

  it("401s an invalid token and creates nothing", async () => {
    verifyTelegramIdToken.mockResolvedValueOnce({ ok: false, error: "invalid_token" });

    const res = await request(buildApp())
      .post("/v1/auth/telegram")
      .send({ idToken: "forged" });

    expect(res.status).toBe(401);
    expect(findOrCreateUserByTelegramLogin).not.toHaveBeenCalled();
  });

  it("502s (retryable) when Telegram's key set is unreachable", async () => {
    // Our outage, not the user's problem: 401 here would tell someone with a
    // perfectly good login that their account is invalid.
    verifyTelegramIdToken.mockResolvedValueOnce({ ok: false, error: "keys_unavailable" });

    const res = await request(buildApp())
      .post("/v1/auth/telegram")
      .send({ idToken: "signed.id.token" });

    expect(res.status).toBe(502);
    expect(findOrCreateUserByTelegramLogin).not.toHaveBeenCalled();
  });

  it("409s a phone/identity collision instead of picking an account", async () => {
    findOrCreateUserByTelegramLogin.mockResolvedValueOnce({ kind: "conflict" });

    const res = await request(buildApp())
      .post("/v1/auth/telegram")
      .send({ idToken: "signed.id.token" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "account_conflict" });
  });
});
