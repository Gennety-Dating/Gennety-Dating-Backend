/**
 * Integration tests for the Verification Mini App API
 * (`/v1/verification/mini-app/*`), now backed by AWS Rekognition Face Liveness.
 *
 * Same shape as location.test.ts — real Express + supertest, mocked Prisma and
 * mocked `liveness-flow` (the shared service both client surfaces call). We
 * verify:
 *   - TMA initData auth on both endpoints (missing / wrong token).
 *   - GET /init maps every `beginLivenessCheck` failure to the right status
 *     (503 not-configured / 503 provider / 404 / 409 already-verified).
 *   - GET /init returns the session + the short-lived AWS credentials the
 *     on-device detector needs.
 *   - POST /event rejects an unknown `kind`, and rejects `complete` without a
 *     sessionId (we cannot read a verdict without one).
 *   - POST /event `complete` settles the check IN-REQUEST — the session dies 3
 *     minutes after /init, so this is the only chance to read the result.
 *   - POST /event surfaces the retry outcome without touching verification.
 *   - POST /event `cancel` / `error` never settle anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-verification-mini-app";

vi.mock("../config.js", () => ({ env: { BOT_TOKEN } }));

const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: userFindUnique } },
}));

const beginLivenessCheck = vi.fn();
const completeLivenessCheck = vi.fn();
vi.mock("../services/liveness-flow.js", () => ({
  beginLivenessCheck,
  completeLivenessCheck,
}));

const runStatusSequence = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/ai-stream.js", () => ({ runStatusSequence }));

const { createVerificationMiniAppRouter } = await import(
  "./routes/verification-mini-app.js"
);

const fakeApi = {} as Parameters<typeof createVerificationMiniAppRouter>[0];

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
  app.use("/v1/verification/mini-app", createVerificationMiniAppRouter(fakeApi));
  return app;
}

function signInitData(
  botToken: string,
  overrides: { authDate?: number; user?: Record<string, unknown> } = {},
): string {
  const params = new URLSearchParams();
  params.set(
    "auth_date",
    String(overrides.authDate ?? Math.floor(Date.now() / 1000)),
  );
  params.set("query_id", "AAH_test");
  params.set(
    "user",
    JSON.stringify(
      overrides.user ?? {
        id: 5986970093,
        first_name: "Pro",
        username: "pro",
      },
    ),
  );
  const sortedKeys = [...params.keys()].sort();
  const dcs = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dcs).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function auth(): string {
  return `tma ${signInitData(BOT_TOKEN)}`;
}

beforeEach(() => {
  userFindUnique.mockReset();
  beginLivenessCheck.mockReset();
  completeLivenessCheck.mockReset();
  runStatusSequence.mockClear();
  userFindUnique.mockResolvedValue({ id: "uid-1", language: "en" });
  beginLivenessCheck.mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    region: "eu-central-1",
    credentials: CREDENTIALS,
    language: "en",
  });
  completeLivenessCheck.mockResolvedValue({ ok: true, outcome: "processing" });
});

describe("GET /v1/verification/mini-app/init", () => {
  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp()).get("/v1/verification/mini-app/init");
    expect(res.status).toBe(401);
  });

  it("returns 401 when initData was signed by a different bot token", async () => {
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${signInitData("999:other-token")}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when the Telegram user has no DB row", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", auth());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("user-not-found");
    expect(beginLivenessCheck).not.toHaveBeenCalled();
  });

  it("returns the session id, region and short-lived credentials", async () => {
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: SESSION_ID,
      region: "eu-central-1",
      credentials: CREDENTIALS,
      language: "en",
    });
    expect(beginLivenessCheck).toHaveBeenCalledWith("uid-1");
  });

  it("returns 503 when the deploy is half-configured", async () => {
    beginLivenessCheck.mockResolvedValueOnce({ ok: false, error: "not_configured" });
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("not-configured");
  });

  it("returns 503 when AWS could not mint a session", async () => {
    beginLivenessCheck.mockResolvedValueOnce({ ok: false, error: "provider" });
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", auth());
    expect(res.status).toBe(503);
  });

  it("returns 409 when the user is already verified — no session is burned", async () => {
    beginLivenessCheck.mockResolvedValueOnce({ ok: false, error: "already_verified" });
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", auth());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already-verified");
  });
});

describe("POST /v1/verification/mini-app/event", () => {
  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .send({ kind: "complete", sessionId: SESSION_ID });
    expect(res.status).toBe(401);
  });

  it("returns 400 on an invalid kind", async () => {
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "🐢" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-kind");
  });

  it("returns 404 when the Telegram user has no DB row", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "complete", sessionId: SESSION_ID });
    expect(res.status).toBe(404);
    expect(completeLivenessCheck).not.toHaveBeenCalled();
  });

  it("returns 400 on `complete` without a sessionId", async () => {
    // Without the session id there is no verdict to read, and the session is
    // already counting down its 3 minutes — fail loudly rather than silently.
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "complete" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing-session-id");
    expect(completeLivenessCheck).not.toHaveBeenCalled();
  });

  it("`complete` settles the check in-request and reports `processing`", async () => {
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "complete", sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: "processing" });
    // Awaited, not fire-and-forget: the AWS session (and its reference image)
    // expires 3 minutes after /init, so the verdict must be read now.
    expect(completeLivenessCheck).toHaveBeenCalledWith("uid-1", SESSION_ID, fakeApi);
    expect(runStatusSequence).toHaveBeenCalledTimes(1);
  });

  it("`complete` reports `retry` without narrating face-match work", async () => {
    completeLivenessCheck.mockResolvedValueOnce({ ok: true, outcome: "retry" });
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "complete", sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: "retry" });
    // Nothing is being checked, and the flow already DM'd the retry prompt.
    expect(runStatusSequence).not.toHaveBeenCalled();
  });

  it("surfaces a provider failure as 503", async () => {
    completeLivenessCheck.mockResolvedValueOnce({ ok: false, error: "provider" });
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "complete", sessionId: SESSION_ID });
    expect(res.status).toBe(503);
  });

  it("`cancel` settles nothing", async () => {
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "cancel" });

    expect(res.status).toBe(200);
    expect(completeLivenessCheck).not.toHaveBeenCalled();
  });

  it("`error` settles nothing", async () => {
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", auth())
      .send({ kind: "error", message: "camera denied" });

    expect(res.status).toBe(200);
    expect(completeLivenessCheck).not.toHaveBeenCalled();
  });
});
