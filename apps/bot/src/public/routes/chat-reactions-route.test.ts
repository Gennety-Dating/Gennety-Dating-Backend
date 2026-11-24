import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and emoji reactions (decision 2026-11-24): `reactions` on history
 * rows, `PUT /v1/chat/messages/:id/reaction`, and the turn that ended in
 * Gennety's reaction — only for a build that sent `reactions`, with the gate on.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "99999999-9999-4999-8999-999999999999";
const MESSAGE = "33333333-3333-4333-8333-333333333333";

const env: Record<string, unknown> = { JWT_SECRET, OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: false, AGENT_REACTIONS_ENABLED: true };
vi.mock("../../config.js", () => ({ env }));
vi.mock("../../services/usage-limiter.js", () => ({
  usageLimiter: { isOverDailyBudget: () => false, isGlobalBudgetExceeded: () => false },
}));

let historyRows: unknown[] = [];
type Row = { id: string; userId: string; role: string; userReaction: string | null; agentReaction: string | null };
let row: Row | null = null;
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ status: "active", onboardingStep: "completed", suspendedUntil: null, language: "ru" }),
    },
    message: {
      findMany: async () => historyRows,
      findUnique: async () => row,
      update: async (a: { data: { userReaction: string | null } }) => {
        row = { ...row!, userReaction: a.data.userReaction };
        return { userReaction: row.userReaction, agentReaction: row.agentReaction };
      },
    },
  },
}));

type TurnInput = { chatCards?: ReadonlySet<string>; reactionsDrawn?: boolean };
let turnResult: Record<string, unknown> = {};
const runChatTurn = vi.fn(async (_input: TurnInput) => turnResult);
vi.mock("../../services/chat-agent.js", () => ({
  runChatTurn: (input: TurnInput) => runChatTurn(input),
}));
vi.mock("../../services/chat-topics.js", () => ({ listChatTopics: async () => ({ topics: [], hasMore: false }) }));
vi.mock("../../services/chat-sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-sessions.js")>();
  return {
    parseChatSessionIdField: original.parseChatSessionIdField,
    normalizeChatSessionTitle: original.normalizeChatSessionTitle,
    claimChatSession: async () => true,
    ownsChatSession: async () => true,
    listChatSessions: async () => ({ sessions: [], hasMore: false }),
    updateChatSession: async () => null,
  };
});
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: async () => ({ path: "p" }),
  createChatImageSignedUrl: async () => "https://signed.example/x",
  createChatImageSignedUrls: async (paths: string[]) => paths.map(() => "https://signed.example/x"),
}));
vi.mock("../../services/whisper.js", () => ({
  transcribeVoiceResult: async () => ({ ok: true, text: "ок, спасибо" }),
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
const auth = (sub = USER_ID) => ({
  Authorization: `Bearer ${jwt.sign({ sub, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  })}`,
});
const REPLY = {
  id: "m1",
  role: "assistant" as const,
  content: "Пожалуйста!",
  imageUrl: null,
  createdAt: new Date("2026-11-24T10:00:00Z"),
  sessionId: "s1",
  userMessageId: "u1",
};
const REACTION_TURN = { kind: "reaction", sessionId: "s1", userMessageId: "u1", agentReaction: { messageId: "u1", emoji: "🙏" } };

beforeEach(() => {
  env.AGENT_REACTIONS_ENABLED = true;
  env.AGENT_REACTIONS_USER_IDS = [];
  historyRows = [];
  row = { id: MESSAGE, userId: USER_ID, role: "assistant", userReaction: null, agentReaction: null };
  turnResult = REPLY;
  runChatTurn.mockClear();
});

describe("history", () => {
  beforeEach(() => {
    historyRows = [
      { id: "u1", role: "user", content: "ок, спасибо", imageUrl: null, imageUrls: [], context: null, attachment: null, agentReaction: "🙏", userReaction: null, createdAt: new Date("2026-11-24T10:00:01Z") },
      { id: "a1", role: "assistant", content: "x", imageUrl: null, imageUrls: [], context: null, attachment: null, userReaction: "❤", agentReaction: null, createdAt: new Date("2026-11-24T10:00:00Z") },
    ];
  });
  const byId = (body: { messages: Array<{ id: string }> }) => Object.fromEntries(body.messages.map((m) => [m.id, m]));

  it("a build that sends `reactions`, gate on: `reactions` on every row", async () => {
    const res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "vibe, reactions");
    const rows = byId(res.body);
    expect(rows.a1).toMatchObject({ reactions: { user: "❤", agent: null } });
    expect(rows.u1).toMatchObject({ reactions: { user: null, agent: "🙏" } });
  });

  it("an older build or the gate off: the field is absent", async () => {
    let res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "vibe");
    for (const m of res.body.messages) expect(m).not.toHaveProperty("reactions");
    env.AGENT_REACTIONS_ENABLED = false;
    res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "reactions");
    for (const m of res.body.messages) expect(m).not.toHaveProperty("reactions");
  });

  it("the preview list turns it on for that person only", async () => {
    env.AGENT_REACTIONS_ENABLED = false;
    env.AGENT_REACTIONS_USER_IDS = [USER_ID];
    const res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "reactions");
    expect(res.body.messages[0]).toHaveProperty("reactions");
  });
});

describe("PUT /v1/chat/messages/:id/reaction", () => {
  const put = (body: unknown, opts: { id?: string; cards?: string; sub?: string } = {}) =>
    request(app())
      .put(`/v1/chat/messages/${opts.id ?? MESSAGE}/reaction`)
      .set(auth(opts.sub))
      .set("X-Gennety-Chat-Cards", opts.cards ?? "reactions")
      .send(body as object);

  it("sets, replaces and takes off; answers ChatReactions", async () => {
    expect((await put({ emoji: "❤️" })).body).toEqual({ user: "❤", agent: null });
    expect((await put({ emoji: "🔥" })).body).toEqual({ user: "🔥", agent: null });
    expect((await put({ emoji: "🔥" })).body).toEqual({ user: null, agent: null });
    await put({ emoji: "👍" });
    expect((await put({})).body).toEqual({ user: null, agent: null });
    await put({ emoji: "👍" });
    const off = await put({ emoji: null });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ user: null, agent: null });
  });

  it("404 with the gate off or for a build without `reactions`", async () => {
    expect((await put({ emoji: "❤" }, { cards: "vibe" })).status).toBe(404);
    env.AGENT_REACTIONS_ENABLED = false;
    expect((await put({ emoji: "❤" })).status).toBe(404);
    expect(row!.userReaction).toBeNull();
  });

  it("404 for someone else's message, a missing one or a non-uuid id", async () => {
    row = { ...row!, userId: OTHER_ID };
    expect((await put({ emoji: "❤" })).status).toBe(404);
    row = null;
    expect((await put({ emoji: "❤" })).status).toBe(404);
    expect((await put({ emoji: "❤" }, { id: "nope" })).status).toBe(404);
  });

  it("409 on the person's own message, 422 for an emoji outside the set", async () => {
    row = { ...row!, role: "user" };
    expect((await put({ emoji: "❤" })).status).toBe(409);
    row = { ...row!, role: "assistant" };
    expect((await put({ emoji: "👎" })).status).toBe(422);
    expect((await put({ emoji: 5 })).status).toBe(422);
  });
});

describe("turn responses", () => {
  it("a build with `reactions`: the turn may react, and a reaction-only turn has no `message`", async () => {
    turnResult = REACTION_TURN;
    const res = await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "reactions").send({ text: "ок, спасибо" });
    expect(res.status).toBe(200);
    expect(runChatTurn.mock.calls[0]![0].reactionsDrawn).toBe(true);
    expect(res.body).not.toHaveProperty("message");
    expect(res.body).toMatchObject({ sessionId: "s1", userMessageId: "u1", agentReaction: { messageId: "u1", emoji: "🙏" } });
  });

  it("an older build: runChatTurn is told it may not react, and the reply carries `message` + `userMessageId`", async () => {
    const res = await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "vibe, reminder").send({ text: "ок, спасибо" });
    expect(runChatTurn.mock.calls[0]![0].reactionsDrawn).toBe(false);
    expect(res.body.message).toMatchObject({ id: "m1", content: "Пожалуйста!" });
    expect(res.body.userMessageId).toBe("u1");
    expect(res.body).not.toHaveProperty("agentReaction");
  });

  it("the gate off: not even a build with `reactions` may get a reaction-only turn", async () => {
    env.AGENT_REACTIONS_ENABLED = false;
    await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "reactions").send({ text: "ок" });
    expect(runChatTurn.mock.calls[0]![0].reactionsDrawn).toBe(false);
  });

  it("a reaction beside a reply: both", async () => {
    turnResult = { ...REPLY, agentReaction: { messageId: "u1", emoji: "❤" } };
    const res = await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "reactions").send({ text: "ок, спасибо" });
    expect(res.body.message).toMatchObject({ id: "m1" });
    expect(res.body.agentReaction).toEqual({ messageId: "u1", emoji: "❤" });
  });

  it("voice: the same, with the transcript", async () => {
    turnResult = REACTION_TURN;
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .set("X-Gennety-Chat-Cards", "reactions")
      .attach("file", Buffer.from("audio"), { filename: "v.m4a", contentType: "audio/m4a" });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("message");
    expect(res.body).toMatchObject({ transcript: "ок, спасибо", userMessageId: "u1", agentReaction: { emoji: "🙏" } });
  });

  it("voice on an older build keeps `message`", async () => {
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .attach("file", Buffer.from("audio"), { filename: "v.m4a", contentType: "audio/m4a" });
    expect(runChatTurn.mock.calls[0]![0].reactionsDrawn).toBe(false);
    expect(res.body.message).toMatchObject({ id: "m1" });
  });
});
