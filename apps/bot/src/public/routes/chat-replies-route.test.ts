import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and suggested replies (decision 2026-11-19): `repliesPending` on a
 * turn, `GET /v1/chat/messages/:id/replies`, the chip tap and the code-owned
 * exit, and chips on the newest history row. The module's own rules are in
 * `services/suggested-replies.test.ts`; this checks the wiring.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";

const env = { JWT_SECRET, OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: true };
vi.mock("../../config.js", () => ({ env }));
vi.mock("../../services/usage-limiter.js", () => ({
  usageLimiter: { isOverDailyBudget: () => false, isGlobalBudgetExceeded: () => false },
}));

const storedChips = {
  kind: "suggested_replies",
  items: [
    { id: "r1", kind: "step", text: "Покажи моё свидание", step: "my_date" },
    { id: "close", kind: "close", text: "На сегодня всё" },
  ],
  tapped: null,
  at: "2026-11-19T10:00:00Z",
};
let historyRows: unknown[] = [];
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ status: "active", onboardingStep: "completed", suspendedUntil: null, language: "ru" }),
    },
    message: { findMany: async () => historyRows, findUnique: async () => null },
  },
}));

const runChatTurn = vi.fn(async (_input: { chatCards?: ReadonlySet<string> }) => ({
  id: "m1",
  role: "assistant" as const,
  content: "Тогда выходи на 15 минут раньше.",
  imageUrl: null,
  createdAt: new Date("2026-10-28T10:00:00Z"),
  sessionId: CHAT,
}));
vi.mock("../../services/chat-agent.js", () => ({
  runChatTurn: (input: { chatCards?: ReadonlySet<string> }) => runChatTurn(input),
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
    renameChatSession: async () => null,
  };
});
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: async () => ({ path: "p" }),
  createChatImageSignedUrl: async () => "https://signed.example/x",
  createChatImageSignedUrls: async (paths: string[]) => paths.map(() => "https://signed.example/x"),
}));
vi.mock("../../services/whisper.js", () => ({
  transcribeVoiceResult: async () => ({ ok: true, text: "x" }),
  WHISPER_MAX_BYTES: 25 * 1024 * 1024,
}));

const startAppReplies = vi.fn(async (_f: { buildDraws: boolean; replyHasCard: boolean; userText: string }) => true);
const appRepliesFor = vi.fn(async (_u: string, _id: string) => [{ id: "r1", kind: "step", text: "Покажи моё свидание" }] as unknown[] | null);
const claimTap = vi.fn(async (_input: { id: unknown }) => null as null | { id: string; kind: string; text: string });
const answerCloseTap = vi.fn(async () => ({ id: "line1", content: "Хорошо. Хорошего дня.", createdAt: new Date("2026-11-19T10:01:00Z") }));
vi.mock("../../services/suggested-replies.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/suggested-replies.js")>();
  return {
    historyReplies: original.historyReplies,
    startAppReplies: (f: never) => startAppReplies(f),
    appRepliesFor: (u: string, id: string) => appRepliesFor(u, id),
    claimTap: (input: never) => claimTap(input),
    answerCloseTap: () => answerCloseTap(),
  };
});

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
  historyRows = [];
  runChatTurn.mockClear();
  startAppReplies.mockClear();
  claimTap.mockClear();
  answerCloseTap.mockClear();
});

describe("a turn", () => {
  it("says repliesPending when the chips call started, with the build's header", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .set("X-Gennety-Chat-Cards", "offer, Replies")
      .send({ text: "в субботу свидание", sessionId: CHAT });
    expect(res.status).toBe(200);
    expect(res.body.repliesPending).toBe(true);
    expect(startAppReplies.mock.calls[0]![0]).toMatchObject({ buildDraws: true, replyHasCard: false, userText: "в субботу свидание" });
  });

  it("omits the field when no chips were started", async () => {
    startAppReplies.mockResolvedValueOnce(false);
    const res = await request(app()).post("/v1/chat/message").set(auth()).send({ text: "привет", sessionId: CHAT });
    expect(res.body).not.toHaveProperty("repliesPending");
  });

  it("answers the exit tap by code, without a turn", async () => {
    claimTap.mockResolvedValueOnce({ id: "close", kind: "close", text: "На сегодня всё" });
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "На сегодня всё", sessionId: CHAT, suggestion: { messageId: MESSAGE, id: "close" } });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: "line1", role: "assistant", content: "Хорошо. Хорошего дня." });
    expect(res.body).not.toHaveProperty("repliesPending");
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("runs any other tap as an ordinary turn", async () => {
    claimTap.mockResolvedValueOnce({ id: "r1", kind: "step", text: "Покажи моё свидание" });
    await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "Покажи моё свидание", sessionId: CHAT, suggestion: { messageId: MESSAGE, id: "r1" } });
    expect(runChatTurn).toHaveBeenCalledOnce();
    expect(answerCloseTap).not.toHaveBeenCalled();
  });
});

describe("GET /v1/chat/messages/:id/replies", () => {
  it("returns the chips", async () => {
    const res = await request(app()).get(`/v1/chat/messages/${MESSAGE}/replies`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replies: [{ id: "r1", kind: "step", text: "Покажи моё свидание" }] });
  });

  it("404 for a non-uuid or a foreign message", async () => {
    expect((await request(app()).get("/v1/chat/messages/nope/replies").set(auth())).status).toBe(404);
    appRepliesFor.mockResolvedValueOnce(null);
    expect((await request(app()).get(`/v1/chat/messages/${MESSAGE}/replies`).set(auth())).status).toBe(404);
  });
});

describe("history", () => {
  const rows = () => [
    { id: "a2", role: "assistant", content: "x", imageUrl: null, imageUrls: [], context: null, attachment: storedChips, createdAt: new Date("2026-11-19T10:00:02Z") },
    { id: "u1", role: "user", content: "y", imageUrl: null, imageUrls: [], context: null, attachment: null, createdAt: new Date("2026-11-19T10:00:01Z") },
    { id: "a1", role: "assistant", content: "z", imageUrl: null, imageUrls: [], context: null, attachment: storedChips, createdAt: new Date("2026-11-19T10:00:00Z") },
  ];

  it("puts chips on the newest row of the chat only, for a build that draws them", async () => {
    historyRows = rows();
    const res = await request(app()).get(`/v1/chat/history?sessionId=${CHAT}`).set(auth()).set("X-Gennety-Chat-Cards", "replies");
    const byId = Object.fromEntries((res.body.messages as Array<{ id: string }>).map((m) => [m.id, m]));
    expect(byId.a2).toMatchObject({ replies: [{ id: "r1", kind: "step", text: "Покажи моё свидание" }, { id: "close", kind: "close", text: "На сегодня всё" }] });
    expect(byId.a1).not.toHaveProperty("replies");
    expect(JSON.stringify(byId.a2)).not.toContain("my_date");
  });

  it("no chips without the header or after a tap", async () => {
    historyRows = rows();
    let res = await request(app()).get(`/v1/chat/history?sessionId=${CHAT}`).set(auth());
    expect(JSON.stringify(res.body)).not.toContain("replies");
    historyRows = rows().map((r) => (r.id === "a2" ? { ...r, attachment: { ...storedChips, tapped: "r1" } } : r));
    res = await request(app()).get(`/v1/chat/history?sessionId=${CHAT}`).set(auth()).set("X-Gennety-Chat-Cards", "replies");
    expect(JSON.stringify(res.body)).not.toContain('"replies"');
  });
});
