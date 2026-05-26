/**
 * Integration test for the `/v1/feedback/post-date` endpoint.
 *
 * Same scope as `calendar.test.ts`: HMAC auth surface + body validation +
 * status-code mapping for the shared `recordPostDateFeedback` reasons +
 * happy path. The pipeline-internal logic (LLM analysis, negative-constraint
 * write, etc.) is covered by `handlers/date/date.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-feedback-suite";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
  },
}));

const recordFn = vi.fn();
vi.mock("../handlers/date/feedback.js", () => ({
  recordPostDateFeedback: recordFn,
}));

const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}));

const { createFeedbackRouter } = await import("./routes/feedback.js");

const sendMessageMock = vi.fn().mockResolvedValue(undefined);
const fakeApi = {
  sendMessage: sendMessageMock,
} as unknown as Parameters<typeof createFeedbackRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/feedback", createFeedbackRouter(fakeApi));
  return app;
}

function signInitData(
  botToken: string,
  overrides: { authDate?: number; user?: Record<string, unknown> } = {},
): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(overrides.authDate ?? Math.floor(Date.now() / 1000)));
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

const VALID_MATCH_ID = "11111111-1111-4111-8111-111111111111";

function happyBody() {
  return {
    matchId: VALID_MATCH_ID,
    chemistry: 8,
    wantsSecondDate: "yes",
    text: "Real chemistry, would meet again.",
    language: "en",
  };
}

describe("POST /v1/feedback/post-date", () => {
  beforeEach(() => {
    recordFn.mockReset();
    userFindUnique.mockReset();
    sendMessageMock.mockClear();
  });

  it("returns 200 and forwards composed text to recordPostDateFeedback on the happy path", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", language: "en" });
    recordFn.mockResolvedValueOnce({ ok: true });

    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send(happyBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordFn).toHaveBeenCalledTimes(1);
    const arg = recordFn.mock.calls[0]![0];
    expect(arg.userId).toBe("uid-1");
    expect(arg.matchId).toBe(VALID_MATCH_ID);
    expect(arg.language).toBe("en");
    // Composed text contains every input axis, language-aware labels.
    expect(arg.text).toContain("Chemistry (1–10): 8");
    expect(arg.text).toContain("Second date?");
    expect(arg.text).toContain("yes");
    expect(arg.text).toContain("Real chemistry, would meet again.");
  });

  it("falls back to the user's stored language when the body language is missing or invalid", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", language: "ru" });
    recordFn.mockResolvedValueOnce({ ok: true });

    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), language: "fr" });

    expect(res.status).toBe(200);
    expect(recordFn.mock.calls[0]![0].language).toBe("ru");
    // Russian labels in the composed prose.
    expect(recordFn.mock.calls[0]![0].text).toContain("Химия");
  });

  it("accepts German and Polish language hints from Mini Apps", async () => {
    const initData = signInitData(BOT_TOKEN);

    userFindUnique.mockResolvedValueOnce({ id: "uid-1", language: "en" });
    recordFn.mockResolvedValueOnce({ ok: true });
    await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), language: "de", wantsSecondDate: "maybe" });
    expect(recordFn.mock.calls[0]![0].language).toBe("de");
    expect(recordFn.mock.calls[0]![0].text).toContain("Zweites Date?");
    expect(recordFn.mock.calls[0]![0].text).toContain("vielleicht");

    userFindUnique.mockResolvedValueOnce({ id: "uid-1", language: "en" });
    recordFn.mockResolvedValueOnce({ ok: true });
    await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), language: "pl", wantsSecondDate: "no" });
    expect(recordFn.mock.calls[1]![0].language).toBe("pl");
    expect(recordFn.mock.calls[1]![0].text).toContain("Druga randka?");
    expect(recordFn.mock.calls[1]![0].text).toContain("nie");
  });

  it("rounds non-integer chemistry into the 1..10 band", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", language: "en" });
    recordFn.mockResolvedValueOnce({ ok: true });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), chemistry: 7.4 });

    expect(res.status).toBe(200);
    expect(recordFn.mock.calls[0]![0].text).toContain("Chemistry (1–10): 7");
  });

  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .send(happyBody());
    expect(res.status).toBe(401);
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization uses a non-tma scheme", async () => {
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", "Bearer something")
      .send(happyBody());
    expect(res.status).toBe(401);
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("returns 401 when initData was signed by a different bot token", async () => {
    const initData = signInitData("999:other-token");
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send(happyBody());
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad-hash");
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("returns 400 when matchId is missing", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), matchId: undefined });
    expect(res.status).toBe(400);
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("returns 400 when chemistry is out of range", async () => {
    const initData = signInitData(BOT_TOKEN);
    for (const value of [0, 11, "abc", null]) {
      const res = await request(buildApp())
        .post("/v1/feedback/post-date")
        .set("Authorization", `tma ${initData}`)
        .send({ ...happyBody(), chemistry: value });
      expect(res.status, `for chemistry=${String(value)}`).toBe(400);
    }
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("returns 400 when wantsSecondDate is not yes|maybe|no", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), wantsSecondDate: "definitely" });
    expect(res.status).toBe(400);
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID matchId with 404 (so Prisma never gets a chance to throw)", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send({ ...happyBody(), matchId: "test-smoke-99999" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("match-not-found");
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("returns 404 when the Telegram user has no Gennety account", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/feedback/post-date")
      .set("Authorization", `tma ${initData}`)
      .send(happyBody());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("user-not-found");
    expect(recordFn).not.toHaveBeenCalled();
  });

  it("maps recordPostDateFeedback failure reasons to HTTP status", async () => {
    userFindUnique.mockResolvedValue({ id: "uid-1", language: "en" });
    const initData = signInitData(BOT_TOKEN);

    const cases: Array<{ reason: string; expected: number }> = [
      { reason: "match-not-found", expected: 404 },
      { reason: "not-participant", expected: 403 },
      { reason: "wrong-state", expected: 400 },
      { reason: "empty-text", expected: 400 },
    ];
    for (const { reason, expected } of cases) {
      recordFn.mockResolvedValueOnce({ ok: false, reason });
      const res = await request(buildApp())
        .post("/v1/feedback/post-date")
        .set("Authorization", `tma ${initData}`)
        .send(happyBody());
      expect(res.status, `for ${reason}`).toBe(expected);
      expect(res.body.error).toBe(reason);
    }
  });
});
