import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Gennety ответил» (app audit 2026-11-15, item 11): a turn whose client hung
 * up before the reply is pushed once; a turn somebody is still waiting on is
 * not. The turn is a stub the test holds open; the push itself is mocked.
 */

const ME = "11111111-1111-4111-8111-111111111111";
let nextId = 0;

const reply = {
  id: "m1",
  role: "assistant" as const,
  content: "Нашёл тебе место.\n\nТихое кафе у парка.",
  imageUrl: null,
  createdAt: new Date("2026-11-15T10:00:00Z"),
  sessionId: "33333333-3333-4333-8333-333333333333",
};
const runChatTurn = vi.fn(async (): Promise<typeof reply> => reply);
vi.mock("../../services/chat-agent.js", () => ({ runChatTurn: () => runChatTurn() }));
vi.mock("../../services/chat-topics.js", () => ({ listChatTopics: vi.fn() }));
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: vi.fn(),
  createChatImageSignedUrl: vi.fn(),
  createChatImageSignedUrls: vi.fn(),
}));
vi.mock("@gennety/db", () => ({ prisma: {} }));
const sendChatReplyPush = vi.fn(async (_input: { userId: string; sessionId: string; content: string }) => true);
vi.mock("../../services/chat-reply-push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/chat-reply-push.js")>();
  return { ...actual, sendChatReplyPush: (input: { userId: string; sessionId: string; content: string }) => sendChatReplyPush(input) };
});
vi.mock("../auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = ME;
    next();
  },
}));
vi.mock("../usage-middleware.js", () => ({
  usageGuard: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../agent-access-middleware.js", () => ({
  requireAgentAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { chatRouter } = await import("./chat.js");

const app = express();
app.use(express.json());
app.use("/v1/chat", chatRouter);

/** A turn parked until `release`. */
function holdTurn() {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  runChatTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(reply);
        started();
      }),
  );
  return { running, release: () => release() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

let id = "";
beforeEach(() => {
  id = `reply-push-id-${++nextId}`;
  runChatTurn.mockReset().mockResolvedValue(reply);
  sendChatReplyPush.mockClear();
});

describe("POST /v1/chat/message — the reply nobody waited for", () => {
  it("a client still there gets the reply and no push", async () => {
    const res = await request(app).post("/v1/chat/message").send({ text: "привет", clientMessageId: id });
    expect(res.status).toBe(200);
    await settle();
    expect(sendChatReplyPush).not.toHaveBeenCalled();
  });

  it("a client that hung up mid-turn gets the push, once, with its chat", async () => {
    const turn = holdTurn();
    const gone = request(app).post("/v1/chat/message").send({ text: "привет", clientMessageId: id }).timeout(40);
    const hungUp = gone.then(
      () => "answered",
      () => "aborted",
    );
    await turn.running;
    expect(await hungUp).toBe("aborted");
    // The server hears the hang-up a tick later.
    await settle();
    turn.release();
    await settle();
    expect(sendChatReplyPush).toHaveBeenCalledTimes(1);
    expect(sendChatReplyPush).toHaveBeenCalledWith({ userId: ME, sessionId: reply.sessionId, content: reply.content });
  });

  it("a retry still waiting on the same turn means no push", async () => {
    const turn = holdTurn();
    const gone = request(app)
      .post("/v1/chat/message")
      .send({ text: "привет", clientMessageId: id })
      .timeout(40)
      .then(
        () => "answered",
        () => "aborted",
      );
    await turn.running;
    expect(await gone).toBe("aborted");
    await settle();
    const retry = request(app).post("/v1/chat/message").send({ text: "привет", clientMessageId: id });
    const pending = retry.then((res) => res);
    await settle();
    turn.release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe(reply.content);
    await settle();
    expect(sendChatReplyPush).not.toHaveBeenCalled();
    expect(runChatTurn).toHaveBeenCalledTimes(1);
  });
});
