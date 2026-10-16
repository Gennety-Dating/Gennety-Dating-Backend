import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` fixes from the 2026-10-11 audit:
 *
 * - C-05: the daily token budget guards the two turns only; history, topics
 *   and sessions still answer once the budget is spent.
 * - C-06: a transcription outage is 503 `transcription_unavailable` (the app
 *   keeps the recording); an empty transcript stays 422.
 * - C-18 / C-17: too long is 413 `{ error: "message_too_long", maxLength }`,
 *   counted in graphemes as iOS counts.
 * - B-09: a retried `clientMessageId` gets the first answer, not a second turn.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";

const env = { JWT_SECRET, LLM_TOKEN_BUDGET_ENABLED: true, OPENAI_API_KEY: "k" };
vi.mock("../../config.js", () => ({ env }));

const budget = vi.hoisted(() => ({ over: false }));
vi.mock("../../services/usage-limiter.js", () => ({
  usageLimiter: {
    isOverDailyBudget: () => budget.over,
    isGlobalBudgetExceeded: () => false,
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({
        status: "active",
        onboardingStep: "completed",
        suspendedUntil: null,
        language: "ru",
      }),
    },
    message: {
      findMany: async () => [],
      findUnique: async () => null,
    },
  },
}));

let turnNo = 0;
const runChatTurn = vi.fn(async (input: { sessionId?: string | null }) => {
  turnNo += 1;
  // Slow enough that a duplicate can arrive while the first is in flight.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    id: `m${turnNo}`,
    role: "assistant" as const,
    content: `Ответ ${turnNo}`,
    imageUrl: null,
    createdAt: new Date("2026-10-11T10:00:00Z"),
    sessionId: input.sessionId ?? CHAT,
  };
});
vi.mock("../../services/chat-agent.js", () => ({
  runChatTurn: (input: { sessionId?: string | null }) => runChatTurn(input),
}));
vi.mock("../../services/chat-topics.js", () => ({
  listChatTopics: async () => ({ topics: [], hasMore: false }),
}));
vi.mock("../../services/chat-sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-sessions.js")>();
  return {
    parseChatSessionIdField: original.parseChatSessionIdField,
    normalizeChatSessionTitle: original.normalizeChatSessionTitle,
    claimChatSession: async () => true,
    ownsChatSession: async () => true,
    listChatSessions: async () => ({ sessions: [], hasMore: false }),
    renameChatSession: async () => null,
  };
});
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: async () => ({ path: "p" }),
  createChatImageSignedUrl: async () => "https://signed.example/x",
  createChatImageSignedUrls: async (paths: string[]) => paths.map(() => "https://signed.example/x"),
}));

const transcription = vi.fn(
  async (): Promise<
    { ok: true; text: string } | { ok: false; reason: "unavailable" | "unusable" }
  > => ({ ok: true, text: "что надеть?" }),
);
vi.mock("../../services/whisper.js", () => ({
  transcribeVoiceResult: () => transcription(),
  WHISPER_MAX_BYTES: 25 * 1024 * 1024,
}));

const { chatRouter } = await import("./chat.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1/chat", chatRouter);
  return a;
}

const auth = () => ({
  Authorization: `Bearer ${jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  })}`,
});

beforeEach(() => {
  budget.over = false;
  runChatTurn.mockClear();
  transcription.mockReset().mockResolvedValue({ ok: true, text: "что надеть?" });
});

describe("C-05: the token budget guards turns, not reads", () => {
  it("over budget, history, topics and sessions still answer", async () => {
    budget.over = true;
    for (const path of ["/v1/chat/history", "/v1/chat/topics", "/v1/chat/sessions"]) {
      const res = await request(app()).get(path).set(auth());
      expect(res.status, path).toBe(200);
    }
  });

  it("over budget, a turn is refused with 429 before the model runs", async () => {
    budget.over = true;
    const res = await request(app()).post("/v1/chat/message").set(auth()).send({ text: "привет" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("daily_token_budget");
    expect(runChatTurn).not.toHaveBeenCalled();

    const voice = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .attach("file", Buffer.from("audio"), { filename: "v.m4a", contentType: "audio/m4a" });
    expect(voice.status).toBe(429);
    expect(transcription).not.toHaveBeenCalled();
  });
});

describe("C-06: voice transcription failures", () => {
  const send = () =>
    request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .attach("file", Buffer.from("audio"), { filename: "v.m4a", contentType: "audio/m4a" });

  it("an outage is 503 transcription_unavailable", async () => {
    transcription.mockResolvedValue({ ok: false, reason: "unavailable" });
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "transcription_unavailable" });
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("silence and an unusable recording stay 422", async () => {
    transcription.mockResolvedValue({ ok: true, text: "" });
    expect((await send()).status).toBe(422);
    transcription.mockResolvedValue({ ok: false, reason: "unusable" });
    expect((await send()).status).toBe(422);
    expect(runChatTurn).not.toHaveBeenCalled();
  });
});

describe("C-18 / C-17: message length", () => {
  it("over the limit is 413 with the limit in the body", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "a".repeat(4_001) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "message_too_long", maxLength: 4_000 });
  });

  it("4000 emoji are 4000 characters, as iOS counts them", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "👍🏽".repeat(4_000) });
    expect(res.status).toBe(200);
  });
});

describe("B-09: clientMessageId", () => {
  it("a retry with the same id gets the first answer without a second turn", async () => {
    const body = { text: "привет", clientMessageId: "retry-0001" };
    const first = await request(app()).post("/v1/chat/message").set(auth()).send(body);
    const again = await request(app()).post("/v1/chat/message").set(auth()).send(body);
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(runChatTurn).toHaveBeenCalledTimes(1);
  });

  it("a duplicate that arrives mid-turn waits for the same turn", async () => {
    const body = { text: "привет", clientMessageId: "inflight-0001" };
    const [a, b] = await Promise.all([
      request(app()).post("/v1/chat/message").set(auth()).send(body),
      request(app()).post("/v1/chat/message").set(auth()).send(body),
    ]);
    expect(a.body).toEqual(b.body);
    expect(runChatTurn).toHaveBeenCalledTimes(1);
  });

  it("without an id (old builds) every send is its own turn", async () => {
    await request(app()).post("/v1/chat/message").set(auth()).send({ text: "раз" });
    await request(app()).post("/v1/chat/message").set(auth()).send({ text: "раз" });
    expect(runChatTurn).toHaveBeenCalledTimes(2);
  });
});

describe("voice with photos (2026-10-16)", () => {
  const own = (n: number) => `${USER_ID}/${1_000 + n}.jpg`;
  const send = (paths: string[]) => {
    let req = request(app()).post("/v1/chat/voice").set(auth());
    for (const path of paths) req = req.field("imageUrls", path);
    return req.attach("file", Buffer.from("audio"), { filename: "v.m4a", contentType: "audio/m4a" });
  };
  const turnImages = () => (runChatTurn.mock.calls[0]?.[0] as { imageUrls?: string[] }).imageUrls;

  it("the photos ride with the transcript into one turn, in the order picked", async () => {
    const res = await send([own(2), own(1)]);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe("что надеть?");
    expect(turnImages()).toEqual([own(2), own(1)]);
  });

  it("a single field is a list of one", async () => {
    expect((await send([own(1)])).status).toBe(200);
    expect(turnImages()).toEqual([own(1)]);
  });

  it("without photos the turn carries none, as before", async () => {
    expect((await send([])).status).toBe(200);
    expect(turnImages()).toEqual([]);
  });

  it("someone else's photo is 403 before Whisper is asked", async () => {
    const res = await send([own(1), "99999999-9999-4999-8999-999999999999/1.jpg"]);
    expect(res.status).toBe(403);
    expect(transcription).not.toHaveBeenCalled();
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("more than 10 photos is 413 before Whisper is asked", async () => {
    const res = await send(Array.from({ length: 11 }, (_, i) => own(i)));
    expect(res.status).toBe(413);
    expect(transcription).not.toHaveBeenCalled();
  });
});
