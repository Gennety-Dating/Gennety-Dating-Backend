/**
 * Native-client verification routes (`/v1/me/verification/native-*`), the JWT
 * twin of the Telegram Mini App router. Both call the same `liveness-flow`
 * service, so these tests focus on the JWT-side wiring: status mapping, the
 * bot-API precondition, and that `complete` settles in-request.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "user-1";
    next();
  },
}));

const beginLivenessCheck = vi.fn();
const completeLivenessCheck = vi.fn();
vi.mock("../services/liveness-flow.js", () => ({
  beginLivenessCheck,
  completeLivenessCheck,
}));

const getBotApi = vi.fn(() => ({ fake: "api" }) as unknown);
vi.mock("./server.js", () => ({ getBotApi }));

const { verificationRouter } = await import("./routes/verification.js");

const CREDENTIALS = {
  accessKeyId: "ASIA_TEMP",
  secretAccessKey: "temp-secret",
  sessionToken: "temp-token",
  expiration: "2026-07-26T12:15:00.000Z",
};
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/verification", verificationRouter);
  return app;
}

beforeEach(() => {
  beginLivenessCheck.mockReset();
  completeLivenessCheck.mockReset();
  getBotApi.mockReturnValue({ fake: "api" });
  beginLivenessCheck.mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    region: "eu-central-1",
    credentials: CREDENTIALS,
    language: "ru",
  });
  completeLivenessCheck.mockResolvedValue({ ok: true, outcome: "processing" });
});

describe("GET /v1/me/verification/native-init", () => {
  it("returns the session, region and short-lived credentials", async () => {
    const res = await request(buildApp()).get("/v1/me/verification/native-init");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: SESSION_ID,
      region: "eu-central-1",
      credentials: CREDENTIALS,
      language: "ru",
    });
    expect(beginLivenessCheck).toHaveBeenCalledWith("user-1");
  });

  it("maps begin failures to 409 / 503 / 404", async () => {
    beginLivenessCheck.mockResolvedValueOnce({ ok: false, error: "already_verified" });
    expect(
      (await request(buildApp()).get("/v1/me/verification/native-init")).status,
    ).toBe(409);

    beginLivenessCheck.mockResolvedValueOnce({ ok: false, error: "not_configured" });
    expect(
      (await request(buildApp()).get("/v1/me/verification/native-init")).status,
    ).toBe(503);

    beginLivenessCheck.mockResolvedValueOnce({ ok: false, error: "user_not_found" });
    expect(
      (await request(buildApp()).get("/v1/me/verification/native-init")).status,
    ).toBe(404);
  });
});

describe("POST /v1/me/verification/native-event", () => {
  it("complete settles the check in-request and returns the outcome", async () => {
    const res = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "complete", sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: "processing" });
    expect(completeLivenessCheck).toHaveBeenCalledWith("user-1", SESSION_ID, {
      fake: "api",
    });
  });

  it("passes the retry outcome through to the client", async () => {
    completeLivenessCheck.mockResolvedValueOnce({ ok: true, outcome: "retry" });
    const res = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "complete", sessionId: SESSION_ID });

    expect(res.body).toEqual({ ok: true, outcome: "retry" });
  });

  it("400s a complete without a sessionId", async () => {
    const res = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "complete" });

    expect(res.status).toBe(400);
    expect(completeLivenessCheck).not.toHaveBeenCalled();
  });

  it("503s rather than consuming a passing check when the bot API isn't up", async () => {
    // The pipeline needs the bot API (Telegram-hosted photos, outcome DMs) and
    // there is no async webhook to settle this later — better to make the user
    // re-run than to read a verdict we cannot act on.
    getBotApi.mockReturnValueOnce(null);
    const res = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "complete", sessionId: SESSION_ID });

    expect(res.status).toBe(503);
    expect(completeLivenessCheck).not.toHaveBeenCalled();
  });

  it("logs cancel/error without settling and rejects unknown kinds", async () => {
    const cancel = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "cancel" });
    expect(cancel.status).toBe(200);
    expect(completeLivenessCheck).not.toHaveBeenCalled();

    const bad = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "nonsense" });
    expect(bad.status).toBe(400);
  });
});
