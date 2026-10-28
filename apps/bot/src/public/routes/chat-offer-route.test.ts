import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and the change-offer card (decision journal 2026-10-28): the
 * `offer` field in a turn's reply and in the history (never `attachment`), and
 * `POST /v1/chat/messages/:id/offer`.
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

const storedOffer = {
  kind: "change_offer",
  state: "open",
  question: "Добавить «парфюмерия» в интересы?",
  acceptLabel: "Добавить",
  tool: "update_hobbies",
  args: { add: ["парфюмерия"] },
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

const offerView = { state: "open", question: storedOffer.question, acceptLabel: "Добавить", receipt: null };
const runChatTurn = vi.fn(async (_input: { chatCards?: ReadonlySet<string> }) => ({
  id: "m1",
  role: "assistant" as const,
  content: "парфюмерный гардероб — это характер.",
  imageUrl: null,
  createdAt: new Date("2026-10-28T10:00:00Z"),
  sessionId: CHAT,
  offer: offerView,
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

type ResolveOfferResult = import("../../services/chat-offer.js").ResolveOfferResult;
const resolveChangeOffer = vi.fn(
  async (_userId: string, _id: string, _action: string): Promise<ResolveOfferResult> => ({
    ok: true,
    offer: { ...storedOffer, state: "accepted", receipt: "Интересы обновлены" } as never,
  }),
);
vi.mock("../../services/chat-offer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-offer.js")>();
  return {
    ...original,
    resolveChangeOffer: (userId: string, id: string, action: string) => resolveChangeOffer(userId, id, action),
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
  resolveChangeOffer.mockClear();
});

describe("a turn", () => {
  it("passes `offer` from the header and returns the card as `offer`", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .set("X-Gennety-Chat-Cards", "wishlist, Offer")
      .send({ text: "у меня парфюмерный гардероб" });
    expect(res.status).toBe(200);
    expect([...runChatTurn.mock.calls[0]![0].chatCards!]).toEqual(["wishlist", "offer"]);
    expect(res.body.offer).toEqual(offerView);
    expect(res.body).not.toHaveProperty("attachment");
  });
});

describe("history", () => {
  it("carries the offer as `offer` — never as `attachment`, never tool or args", async () => {
    historyRows = [
      { id: "a1", role: "assistant", content: "x", imageUrl: null, imageUrls: [], context: null, attachment: storedOffer, createdAt: new Date("2026-10-28T10:00:01Z") },
      { id: "u1", role: "user", content: "y", imageUrl: null, imageUrls: [], context: null, attachment: null, createdAt: new Date("2026-10-28T10:00:00Z") },
    ];
    const res = await request(app()).get("/v1/chat/history").set(auth());
    const byId = Object.fromEntries((res.body.messages as Array<{ id: string }>).map((m) => [m.id, m]));
    expect(byId.a1).toMatchObject({ offer: offerView });
    expect(byId.a1).not.toHaveProperty("attachment");
    expect(JSON.stringify(byId.a1)).not.toContain("update_hobbies");
    expect(byId.u1).not.toHaveProperty("offer");
  });
});

describe("POST /v1/chat/messages/:id/offer", () => {
  const post = (body: unknown, id = MESSAGE) =>
    request(app()).post(`/v1/chat/messages/${id}/offer`).set(auth()).send(body as object);

  it("accept answers the offer as it now is, with the receipt", async () => {
    const res = await post({ action: "accept" });
    expect(res.status).toBe(200);
    expect(resolveChangeOffer).toHaveBeenCalledWith(USER_ID, MESSAGE, "accept");
    expect(res.body).toEqual({
      offer: { state: "accepted", question: storedOffer.question, acceptLabel: "Добавить", receipt: "Интересы обновлены" },
    });
  });

  it("decline", async () => {
    await post({ action: "decline" });
    expect(resolveChangeOffer).toHaveBeenCalledWith(USER_ID, MESSAGE, "decline");
  });

  it("refuses a malformed answer before touching anything", async () => {
    for (const body of [{}, { action: "yes" }, { action: "save" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(resolveChangeOffer).not.toHaveBeenCalled();
  });

  it("404 for a non-uuid id, or a foreign message / no offer", async () => {
    expect((await post({ action: "accept" }, "not-a-uuid")).status).toBe(404);
    resolveChangeOffer.mockResolvedValueOnce({ ok: false, error: "not-found" });
    expect((await post({ action: "accept" })).status).toBe(404);
  });

  it("422 with the message when the change is refused", async () => {
    resolveChangeOffer.mockResolvedValueOnce({ ok: false, error: "change-failed", message: "The list holds 12 interests" });
    const res = await post({ action: "accept" });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "change-failed", message: "The list holds 12 interests" });
  });

  it("needs a session", async () => {
    const res = await request(app()).post(`/v1/chat/messages/${MESSAGE}/offer`).send({ action: "accept" });
    expect(res.status).toBe(401);
  });
});
