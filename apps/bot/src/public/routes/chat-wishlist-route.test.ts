import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and the wishlist card (decision journal 2026-10-15): the header
 * that says the build draws it, the card in the reply and in the history, and
 * `POST /v1/chat/messages/:id/wishlist`.
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

const storedCard = {
  kind: "wishlist_proposal",
  state: "open",
  items: [
    { key: "i1", title: "Lost Cherry", brand: "Tom Ford", category: "perfume", note: null, photoPath: null, remoteImageUrl: "https://cdn.example/a.jpg", productUrl: null, priceBand: null, source: "search" },
  ],
  savedKeys: [],
  resolvedAt: null,
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
  content: "добавить в вишлист?",
  imageUrl: null,
  createdAt: new Date("2026-10-15T10:00:00Z"),
  sessionId: CHAT,
  attachment: { kind: "wishlist_proposal", state: "open", items: [], savedCount: 0 },
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

type ResolveResult = import("../../services/chat-wishlist.js").ResolveResult;
const resolveWishlistCard = vi.fn(
  async (_userId: string, _id: string, _input: unknown): Promise<ResolveResult> => ({
    ok: true,
    card: { ...storedCard, state: "saved", savedKeys: ["i1"] } as never,
  }),
);
vi.mock("../../services/chat-wishlist.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-wishlist.js")>();
  return {
    readWishlistCard: original.readWishlistCard,
    resolveWishlistCard: (userId: string, id: string, input: unknown) => resolveWishlistCard(userId, id, input),
    wishlistCardViews: async (cards: Array<{ state: string; savedKeys: string[] }>) =>
      cards.map((card) => ({ kind: "wishlist_proposal", state: card.state, items: [], savedCount: card.savedKeys.length })),
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
  env.WISHLIST_FEATURE_ENABLED = true;
  historyRows = [];
  runChatTurn.mockClear();
  resolveWishlistCard.mockClear();
});

describe("a turn", () => {
  it("passes the cards the build draws and returns the card", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .set("X-Gennety-Chat-Cards", "Wishlist, future")
      .send({ text: "вот мои духи" });
    expect(res.status).toBe(200);
    expect([...runChatTurn.mock.calls[0]![0].chatCards!]).toEqual(["wishlist", "future"]);
    expect(res.body.attachment).toMatchObject({ kind: "wishlist_proposal", state: "open" });
  });

  it("no header — no cards", async () => {
    await request(app()).post("/v1/chat/message").set(auth()).send({ text: "привет" });
    expect(runChatTurn.mock.calls[0]![0].chatCards!.size).toBe(0);
  });
});

describe("history", () => {
  const rows = () => [
    { id: "a1", role: "assistant", content: "добавить?", imageUrl: null, imageUrls: [], context: null, attachment: storedCard, createdAt: new Date("2026-10-15T10:00:01Z") },
    { id: "u1", role: "user", content: "духи", imageUrl: null, imageUrls: [], context: null, attachment: null, createdAt: new Date("2026-10-15T10:00:00Z") },
  ];

  it("carries the card under its reply, nothing under other rows", async () => {
    historyRows = rows();
    const res = await request(app()).get("/v1/chat/history").set(auth());
    const byId = Object.fromEntries((res.body.messages as Array<{ id: string }>).map((m) => [m.id, m]));
    expect(byId.a1).toMatchObject({ attachment: { kind: "wishlist_proposal", state: "open" } });
    expect(byId.u1).not.toHaveProperty("attachment");
  });

  it("shows no card while the feature is off", async () => {
    env.WISHLIST_FEATURE_ENABLED = false;
    historyRows = rows();
    const res = await request(app()).get("/v1/chat/history").set(auth());
    expect((res.body.messages as Array<Record<string, unknown>>).every((m) => !("attachment" in m))).toBe(true);
  });
});

describe("POST /v1/chat/messages/:id/wishlist", () => {
  const post = (body: unknown, id = MESSAGE) =>
    request(app()).post(`/v1/chat/messages/${id}/wishlist`).set(auth()).send(body as object);

  it("saves the ticked keys and answers the card as it now is", async () => {
    const res = await post({ action: "save", keys: ["i1"] });
    expect(res.status).toBe(200);
    expect(resolveWishlistCard).toHaveBeenCalledWith(USER_ID, MESSAGE, { action: "save", keys: ["i1"] });
    expect(res.body.attachment).toMatchObject({ state: "saved", savedCount: 1 });
  });

  it("dismisses", async () => {
    await post({ action: "dismiss" });
    expect(resolveWishlistCard).toHaveBeenCalledWith(USER_ID, MESSAGE, { action: "dismiss" });
  });

  it("refuses a malformed answer before touching anything", async () => {
    for (const body of [{}, { action: "save" }, { action: "save", keys: [] }, { action: "save", keys: [1] }, { action: "nope" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(resolveWishlistCard).not.toHaveBeenCalled();
  });

  it("404 for a non-uuid id, an unknown card, or the feature off", async () => {
    expect((await post({ action: "dismiss" }, "not-a-uuid")).status).toBe(404);
    resolveWishlistCard.mockResolvedValueOnce({ ok: false, error: "not-found" });
    expect((await post({ action: "dismiss" })).status).toBe(404);
    env.WISHLIST_FEATURE_ENABLED = false;
    expect((await post({ action: "dismiss" })).status).toBe(404);
  });

  it("409 with the room left when the list is full", async () => {
    resolveWishlistCard.mockResolvedValueOnce({ ok: false, error: "too-many", room: 2 });
    const res = await post({ action: "save", keys: ["i1", "i2", "i3"] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "too-many", room: 2 });
  });

  it("needs a session", async () => {
    const res = await request(app()).post(`/v1/chat/messages/${MESSAGE}/wishlist`).send({ action: "dismiss" });
    expect(res.status).toBe(401);
  });
});
