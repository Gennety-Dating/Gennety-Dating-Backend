import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and chat sessions (decision journal 2026-09-30): the list and the
 * rename, `sessionId` on a turn (new / foreign / absent / malformed), history
 * paged by one chat, and a page's photos signed in one request.
 *
 * The session SQL itself is covered against a real Postgres in
 * `services/chat-sessions.integration.test.ts`; here the service is a double
 * and the route's own decisions are what is pinned.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const OTHER_CHAT = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";

const env = { JWT_SECRET, LLM_TOKEN_BUDGET_ENABLED: false, OPENAI_API_KEY: "k" };
vi.mock("../../config.js", () => ({ env }));

const messageFindMany = vi.fn(async (_args: unknown): Promise<unknown[]> => []);
const messageFindUnique = vi.fn(async (_args: unknown): Promise<unknown> => null);
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
      findMany: (args: unknown) => messageFindMany(args),
      findUnique: (args: unknown) => messageFindUnique(args),
    },
  },
}));

const runChatTurn = vi.fn(async (input: { sessionId?: string | null }) => ({
  id: "m1",
  role: "assistant" as const,
  content: "Ок.",
  imageUrl: null,
  createdAt: new Date("2026-09-30T10:00:00Z"),
  sessionId: input.sessionId ?? OTHER_CHAT,
}));
vi.mock("../../services/chat-agent.js", () => ({
  runChatTurn: (input: { sessionId?: string | null }) => runChatTurn(input),
}));
vi.mock("../../services/chat-topics.js", () => ({
  listChatTopics: async () => ({ topics: [], hasMore: false }),
}));

const claimChatSession = vi.fn(async (_u: string, _s: string) => true);
const ownsChatSession = vi.fn(async (_u: string, _s: string) => true);
const listChatSessions = vi.fn(async (_u: string, _o: unknown): Promise<unknown> => ({
  sessions: [],
  hasMore: false,
}));
const renameChatSession = vi.fn(async (_u: string, _s: string, _t: string): Promise<unknown> => null);
vi.mock("../../services/chat-sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-sessions.js")>();
  return {
    // The parsers are the real ones — they ARE the route's input contract.
    parseChatSessionIdField: original.parseChatSessionIdField,
    normalizeChatSessionTitle: original.normalizeChatSessionTitle,
    claimChatSession: (u: string, s: string) => claimChatSession(u, s),
    ownsChatSession: (u: string, s: string) => ownsChatSession(u, s),
    listChatSessions: (u: string, o: unknown) => listChatSessions(u, o),
    renameChatSession: (u: string, s: string, t: string) => renameChatSession(u, s, t),
  };
});

const signBatch = vi.fn(async (paths: string[]) => paths.map((p) => `https://signed.example/${p}`));
const signOne = vi.fn(async (path: string) => `https://signed.example/${path}`);
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: async () => ({ path: "p" }),
  createChatImageSignedUrl: (path: string) => signOne(path),
  createChatImageSignedUrls: (paths: string[]) => signBatch(paths),
}));

const transcribeVoice = vi.fn(async () => "что надеть?");
vi.mock("../../services/whisper.js", () => ({
  transcribeVoice: () => transcribeVoice(),
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

const session = (id: string, title: string) => ({
  id,
  title,
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T11:00:00.000Z",
  messageCount: 4,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  runChatTurn.mockClear();
  transcribeVoice.mockClear();
  claimChatSession.mockReset().mockResolvedValue(true);
  ownsChatSession.mockReset().mockResolvedValue(true);
  listChatSessions.mockReset().mockResolvedValue({ sessions: [], hasMore: false });
  renameChatSession.mockReset().mockResolvedValue(null);
  messageFindMany.mockReset().mockResolvedValue([]);
  messageFindUnique.mockReset().mockResolvedValue(null);
  signBatch.mockClear();
  signOne.mockClear();
});

describe("GET /v1/chat/sessions", () => {
  it("lists the caller's chats with the default page size", async () => {
    listChatSessions.mockResolvedValue({ sessions: [session(CHAT, "Дресс-код")], hasMore: true });

    const res = await request(app()).get("/v1/chat/sessions").set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [session(CHAT, "Дресс-код")], hasMore: true });
    expect(listChatSessions).toHaveBeenCalledWith(USER_ID, { limit: 30, before: null });
  });

  it("pages with `before` and clamps the limit", async () => {
    await request(app()).get(`/v1/chat/sessions?limit=500&before=${CHAT.toUpperCase()}`).set(auth());
    expect(listChatSessions).toHaveBeenCalledWith(USER_ID, { limit: 100, before: CHAT });

    await request(app()).get("/v1/chat/sessions?limit=0").set(auth());
    expect(listChatSessions).toHaveBeenLastCalledWith(USER_ID, { limit: 30, before: null });
  });

  it("an unknown or foreign cursor is a 404", async () => {
    listChatSessions.mockResolvedValue(null);
    const res = await request(app()).get(`/v1/chat/sessions?before=${OTHER_CHAT}`).set(auth());
    expect(res.status).toBe(404);
  });

  it("needs a token", async () => {
    const res = await request(app()).get("/v1/chat/sessions");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /v1/chat/sessions/:id", () => {
  it("renames with the title trimmed and whitespace collapsed", async () => {
    renameChatSession.mockResolvedValue(session(CHAT, "Про Аню"));

    const res = await request(app())
      .patch(`/v1/chat/sessions/${CHAT}`)
      .set(auth())
      .send({ title: "  Про\n Аню  " });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Про Аню");
    expect(renameChatSession).toHaveBeenCalledWith(USER_ID, CHAT, "Про Аню");
  });

  it("an empty, blank, overlong or missing title is a 400 and touches nothing", async () => {
    for (const title of ["", "   ", "x".repeat(81), 42, undefined]) {
      const res = await request(app()).patch(`/v1/chat/sessions/${CHAT}`).set(auth()).send({ title });
      expect(res.status, String(title)).toBe(400);
    }
    expect(renameChatSession).not.toHaveBeenCalled();
  });

  it("80 characters is still a title", async () => {
    renameChatSession.mockResolvedValue(session(CHAT, "x".repeat(80)));
    const res = await request(app())
      .patch(`/v1/chat/sessions/${CHAT}`)
      .set(auth())
      .send({ title: "x".repeat(80) });
    expect(res.status).toBe(200);
  });

  it("someone else's chat is the same 404 as one that never existed", async () => {
    const res = await request(app())
      .patch(`/v1/chat/sessions/${OTHER_CHAT}`)
      .set(auth())
      .send({ title: "Моё" });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/chat/message with sessionId", () => {
  it("claims the client-minted id and runs the turn in it", async () => {
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "что надеть?", sessionId: CHAT.toUpperCase() });

    expect(res.status).toBe(200);
    expect(claimChatSession).toHaveBeenCalledWith(USER_ID, CHAT);
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: CHAT }));
    expect(res.body.sessionId).toBe(CHAT);
  });

  it("someone else's chat is a 404 and costs no turn", async () => {
    claimChatSession.mockResolvedValue(false);
    const res = await request(app())
      .post("/v1/chat/message")
      .set(auth())
      .send({ text: "x", sessionId: OTHER_CHAT });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Unknown context" });
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("a sessionId that is not a UUID is a 400", async () => {
    for (const sessionId of ["nope", 42, "", { id: CHAT }]) {
      const res = await request(app())
        .post("/v1/chat/message")
        .set(auth())
        .send({ text: "x", sessionId });
      expect(res.status, JSON.stringify(sessionId)).toBe(400);
    }
    expect(claimChatSession).not.toHaveBeenCalled();
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("an older build that sends none gets the legacy rule and learns the chat", async () => {
    const res = await request(app()).post("/v1/chat/message").set(auth()).send({ text: "привет" });

    expect(res.status).toBe(200);
    expect(claimChatSession).not.toHaveBeenCalled();
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
    expect(res.body.sessionId).toBe(OTHER_CHAT);
  });
});

describe("POST /v1/chat/voice with sessionId", () => {
  it("refuses someone else's chat before paying for a transcription", async () => {
    claimChatSession.mockResolvedValue(false);
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .field("sessionId", OTHER_CHAT)
      .attach("file", Buffer.from("fake-m4a"), { filename: "v.m4a", contentType: "audio/mp4" });
    expect(res.status).toBe(404);
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before paying for a transcription", async () => {
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .field("sessionId", "not-a-uuid")
      .attach("file", Buffer.from("fake-m4a"), { filename: "v.m4a", contentType: "audio/mp4" });
    expect(res.status).toBe(400);
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("carries the chat into the voice turn and the answer", async () => {
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .field("sessionId", CHAT)
      .attach("file", Buffer.from("fake-m4a"), { filename: "v.m4a", contentType: "audio/mp4" });
    expect(res.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: CHAT }));
    expect(res.body).toMatchObject({ sessionId: CHAT, transcript: "что надеть?" });
  });
});

describe("GET /v1/chat/history by chat", () => {
  const row = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: "user",
    content: "x",
    imageUrl: null,
    imageUrls: [],
    context: null,
    createdAt: new Date(at),
    ...extra,
  });

  it("filters to the chat when one is named", async () => {
    await request(app()).get(`/v1/chat/history?sessionId=${CHAT}`).set(auth());

    expect(ownsChatSession).toHaveBeenCalledWith(USER_ID, CHAT);
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, role: { not: "system" }, sessionId: CHAT },
      }),
    );
  });

  it("without one, pages the whole stream as before", async () => {
    await request(app()).get("/v1/chat/history").set(auth());
    expect(ownsChatSession).not.toHaveBeenCalled();
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, role: { not: "system" } } }),
    );
  });

  it("an unknown or foreign chat is a 404", async () => {
    ownsChatSession.mockResolvedValue(false);
    const res = await request(app()).get(`/v1/chat/history?sessionId=${OTHER_CHAT}`).set(auth());
    expect(res.status).toBe(404);
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  it("a cursor from another chat of the same person is a 404", async () => {
    messageFindUnique.mockResolvedValue({ userId: USER_ID, sessionId: OTHER_CHAT });
    const res = await request(app())
      .get(`/v1/chat/history?sessionId=${CHAT}&before=${MSG}`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("a cursor from the same chat pages it", async () => {
    messageFindUnique.mockResolvedValue({ userId: USER_ID, sessionId: CHAT });
    const res = await request(app())
      .get(`/v1/chat/history?sessionId=${CHAT}&before=${MSG}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: MSG }, skip: 1 }),
    );
  });

  it("a cursor that is not a UUID is a 404, not a Prisma 500", async () => {
    const res = await request(app()).get("/v1/chat/history?before=abc").set(auth());
    expect(res.status).toBe(404);
    expect(messageFindUnique).not.toHaveBeenCalled();
  });

  it("signs every photo of the page in one batch; signedImageUrl is the first of the list", async () => {
    messageFindMany.mockResolvedValue([
      row("c", "2026-09-30T10:00:02Z", { imageUrl: "u/3.jpg", imageUrls: [] }),
      row("b", "2026-09-30T10:00:01Z"),
      row("a", "2026-09-30T10:00:00Z", { imageUrl: "u/1.jpg", imageUrls: ["u/1.jpg", "u/2.jpg"] }),
    ]);

    const res = await request(app()).get("/v1/chat/history").set(auth());

    expect(signBatch).toHaveBeenCalledTimes(1);
    expect(signBatch).toHaveBeenCalledWith(["u/1.jpg", "u/2.jpg", "u/3.jpg"]);
    expect(signOne).not.toHaveBeenCalled();
    const [a, b, c] = res.body.messages;
    expect(a).toMatchObject({
      id: "a",
      imageUrls: ["u/1.jpg", "u/2.jpg"],
      signedImageUrls: ["https://signed.example/u/1.jpg", "https://signed.example/u/2.jpg"],
      signedImageUrl: "https://signed.example/u/1.jpg",
    });
    expect(b).toMatchObject({ id: "b", imageUrls: [], signedImageUrls: [], signedImageUrl: null });
    // A row from before the list: its single path is the list.
    expect(c).toMatchObject({
      id: "c",
      imageUrls: ["u/3.jpg"],
      signedImageUrl: "https://signed.example/u/3.jpg",
    });
  });

  it("an object that could not be signed is an empty string, as before", async () => {
    signBatch.mockResolvedValueOnce([null] as unknown as string[]);
    messageFindMany.mockResolvedValue([
      row("a", "2026-09-30T10:00:00Z", { imageUrl: "u/1.jpg", imageUrls: ["u/1.jpg"] }),
    ]);
    const res = await request(app()).get("/v1/chat/history").set(auth());
    expect(res.body.messages[0]).toMatchObject({ signedImageUrl: "", signedImageUrls: [""] });
  });

  it("logs one timing line per request", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    messageFindMany.mockResolvedValue([row("a", "2026-09-30T10:00:00Z", { imageUrls: ["u/1.jpg"] })]);
    await request(app()).get("/v1/chat/history").set(auth());
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[chat/history]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/rows=1 images=1 sign_ms=\d+ total_ms=\d+/);
  });
});
