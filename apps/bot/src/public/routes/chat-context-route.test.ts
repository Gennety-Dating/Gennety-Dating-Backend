import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and the context chip (decision journal 2026-09-13): the request
 * carries a reference, the route checks it is the caller's before a single
 * token is spent, and history hands the chip back.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

const env = { JWT_SECRET, LLM_TOKEN_BUDGET_ENABLED: false, OPENAI_API_KEY: "k" };
vi.mock("../../config.js", () => ({ env }));

const messageFindMany = vi.fn(async (_args: unknown): Promise<unknown[]> => []);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ status: "active", onboardingStep: "completed", suspendedUntil: null, language: "ru" }),
    },
    message: { findMany: (args: unknown) => messageFindMany(args), findUnique: async () => null },
  },
}));

const runChatTurn = vi.fn(async (_input: unknown) => ({
  id: "m1",
  role: "assistant" as const,
  content: "Smart casual.",
  imageUrl: null,
  createdAt: new Date("2026-09-13T10:00:00Z"),
}));
vi.mock("../../services/chat-agent.js", () => ({ runChatTurn: (input: unknown) => runChatTurn(input) }));
vi.mock("../../services/chat-topics.js", () => ({ listChatTopics: async () => ({ topics: [], hasMore: false }) }));
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: async () => ({ path: "p" }),
  createChatImageSignedUrl: async () => "https://signed.example/x",
}));

const transcribeVoice = vi.fn(async () => "какой дресс-код?");
vi.mock("../../services/whisper.js", () => ({
  transcribeVoice: () => transcribeVoice(),
  WHISPER_MAX_BYTES: 25 * 1024 * 1024,
}));

const resolveChatContextSnapshot = vi.fn();
vi.mock("../../services/chat-context.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-context.js")>();
  return { ...original, resolveChatContextSnapshot: (...a: unknown[]) => resolveChatContextSnapshot(...a) };
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

const snapshot = { kind: "inbox_item", id: ITEM, title: "Launch Night" };

beforeEach(() => {
  runChatTurn.mockClear();
  transcribeVoice.mockClear();
  messageFindMany.mockReset().mockResolvedValue([]);
  resolveChatContextSnapshot.mockReset().mockResolvedValue(snapshot);
});

describe("POST /v1/chat/message with a context chip", () => {
  it("hands the checked snapshot to the turn", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "какой дресс-код?", context: { kind: "inbox_item", id: ITEM } });

    expect(res.status).toBe(200);
    expect(resolveChatContextSnapshot).toHaveBeenCalledWith(USER_ID, { kind: "inbox_item", id: ITEM });
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ context: snapshot }));
  });

  it("answers an ordinary message with no context at all", async () => {
    await request(app()).post("/v1/chat/message").set(auth()).send({ text: "привет" });
    expect(resolveChatContextSnapshot).not.toHaveBeenCalled();
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ context: null }));
  });

  it("refuses a malformed chip before the model runs", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "x", context: { kind: "inbox_item", id: "../../x" } });
    expect(res.status).toBe(400);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("gives someone else's inbox row the same 404 as a row that never existed", async () => {
    resolveChatContextSnapshot.mockResolvedValue(null);
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "x", context: { kind: "inbox_item", id: ITEM } });
    expect(res.status).toBe(404);
    expect(runChatTurn).not.toHaveBeenCalled();
  });
});

describe("POST /v1/chat/voice with a context chip", () => {
  it("checks the chip before paying for a transcription", async () => {
    resolveChatContextSnapshot.mockResolvedValue(null);
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .field("contextKind", "inbox_item")
      .field("contextId", ITEM)
      .attach("file", Buffer.from("fake-m4a"), { filename: "v.m4a", contentType: "audio/mp4" });
    expect(res.status).toBe(404);
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("carries the chip into the voice turn", async () => {
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .field("contextKind", "inbox_item")
      .field("contextId", ITEM)
      .attach("file", Buffer.from("fake-m4a"), { filename: "v.m4a", contentType: "audio/mp4" });
    expect(res.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ context: snapshot }));
  });
});

describe("GET /v1/chat/history", () => {
  it("returns the chip on the message it was sent with, and omits it elsewhere", async () => {
    messageFindMany.mockResolvedValue([
      { id: "b", role: "assistant", content: "Smart casual.", imageUrl: null, imageUrls: [], context: null, createdAt: new Date("2026-09-13T10:00:01Z") },
      { id: "a", role: "user", content: "какой дресс-код?", imageUrl: null, imageUrls: [], context: snapshot, createdAt: new Date("2026-09-13T10:00:00Z") },
    ]);

    const res = await request(app()).get("/v1/chat/history").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({ id: "a", context: snapshot });
    expect(res.body.messages[1]).not.toHaveProperty("context");
  });
});
