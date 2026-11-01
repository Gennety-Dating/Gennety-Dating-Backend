import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /v1/chat/activity` beside a blocking `POST /v1/chat/message`: who can
 * read what, what a poll sees as a turn moves, and that the status ends with the
 * turn however the turn ends. The route polls the real store, and the turn is a
 * stub the test holds open.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
/** Fresh per test: `chatSends` in the route remembers an id for ten minutes. */
let ID = "";
let nextId = 0;
const NOTHING = { step: null, seq: 0 };

type Step = import("../../services/chat-activity.js").ChatActivityStep;
type Input = { onStep?: (step: Step) => void };

const reply = {
  id: "m1",
  role: "assistant" as const,
  content: "ок",
  imageUrl: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  sessionId: "s1",
};
const runChatTurn = vi.fn(async (_input: Input): Promise<typeof reply> => reply);
vi.mock("../../services/chat-agent.js", () => ({ runChatTurn: (input: Input) => runChatTurn(input) }));
vi.mock("../../services/chat-topics.js", () => ({ listChatTopics: vi.fn() }));
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: vi.fn(),
  createChatImageSignedUrl: vi.fn(),
  createChatImageSignedUrls: vi.fn(),
}));
vi.mock("@gennety/db", () => ({ prisma: {} }));
vi.mock("../auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string; headers: Record<string, string | undefined> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const user = req.headers["x-test-user"];
    if (!user) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    req.userId = user;
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
const { chatActivity } = await import("../../services/chat-activity.js");

const app = express();
app.use(express.json());
app.use("/v1/chat", chatRouter);

const poll = (user = ME, id = ID) =>
  request(app).get("/v1/chat/activity").query({ clientMessageId: id }).set("x-test-user", user);

/** A send that goes out now; a turn parked until `release`. */
function holdTurn() {
  let release!: (fail?: Error) => void;
  let seen!: Input;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  runChatTurn.mockImplementationOnce(
    (input: Input) =>
      new Promise((resolve, reject) => {
        seen = input;
        release = (fail) => (fail ? reject(fail) : resolve(reply));
        started();
      }),
  );
  return { running, release: (fail?: Error) => release(fail), step: (s: Step) => seen.onStep?.(s) };
}

const send = (id = ID) =>
  request(app).post("/v1/chat/message").set("x-test-user", ME).send({ text: "привет", clientMessageId: id }).then((res) => res);

beforeEach(() => {
  ID = `client-message-id-${++nextId}`;
  chatActivity.clear();
  runChatTurn.mockReset().mockResolvedValue(reply);
});

describe("GET /v1/chat/activity", () => {
  it("asks for auth", async () => {
    const res = await request(app).get("/v1/chat/activity").query({ clientMessageId: ID });
    expect(res.status).toBe(401);
  });

  it("answers 200 and null for an unknown, a missing or a malformed id, uncached", async () => {
    const unknown = await poll();
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(NOTHING);
    expect(unknown.headers["cache-control"]).toBe("no-store");

    const missing = await request(app).get("/v1/chat/activity").set("x-test-user", ME);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual(NOTHING);

    const repeated = await request(app).get(`/v1/chat/activity?clientMessageId=${ID}&clientMessageId=${ID}`).set("x-test-user", ME);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(NOTHING);
  });

  it("follows the turn step by step and ends with it", async () => {
    const turn = holdTurn();
    const sending = send();
    await turn.running;

    expect((await poll()).body).toEqual({ step: "thinking", seq: 1 });
    turn.step("web");
    expect((await poll()).body).toEqual({ step: "web", seq: 2 });
    turn.step("writing");
    expect((await poll()).body).toEqual({ step: "writing", seq: 3 });

    turn.release();
    expect((await sending).status).toBe(200);
    expect((await poll()).body).toEqual(NOTHING);
  });

  it("does not show one person's turn to another", async () => {
    const turn = holdTurn();
    const sending = send();
    await turn.running;

    expect((await poll(OTHER)).body).toEqual(NOTHING);
    expect((await poll(ME)).body).toEqual({ step: "thinking", seq: 1 });

    turn.release();
    await sending;
  });

  it("ends the status of a turn the agent could not answer, and a retry starts afresh", async () => {
    const turn = holdTurn();
    const sending = send();
    await turn.running;
    turn.step("web");
    const unavailable = new Error("no reply");
    unavailable.name = "ChatAgentUnavailableError";
    turn.release(unavailable);

    expect((await sending).status).toBe(503);
    expect((await poll()).body).toEqual(NOTHING);

    const retry = holdTurn();
    const resending = send();
    await retry.running;
    expect((await poll()).body).toEqual({ step: "thinking", seq: 1 });
    retry.release();
    expect((await resending).status).toBe(200);
  });

  it("ends the status of a turn that threw", async () => {
    const turn = holdTurn();
    const sending = send();
    await turn.running;
    turn.release(new Error("boom"));

    expect((await sending).status).toBe(500);
    expect((await poll()).body).toEqual(NOTHING);
  });

  it("a retry answered from the first turn gets its reply and starts no status", async () => {
    expect((await send()).status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledTimes(1);

    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.message.id).toBe("m1");
    expect(runChatTurn).toHaveBeenCalledTimes(1);
    expect((await poll()).body).toEqual(NOTHING);
  });

  it("a retry during the first turn joins it, and the status stays that turn's", async () => {
    const turn = holdTurn();
    const first = send();
    await turn.running;
    turn.step("profile");

    const second = send();
    await vi.waitFor(async () => {
      expect((await poll()).body).toEqual({ step: "profile", seq: 2 });
    });

    turn.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledTimes(1);
  });

  it("a send without an id runs as before and reports nowhere", async () => {
    const res = await request(app).post("/v1/chat/message").set("x-test-user", ME).send({ text: "привет" });
    expect(res.status).toBe(200);
    expect(runChatTurn.mock.calls[0]![0].onStep).toBeUndefined();
  });

  it("polling every 800 ms for a minute fits, and leaves the send budget whole", async () => {
    for (let i = 0; i < 75; i++) {
      expect((await poll()).status).toBe(200);
    }
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toContain("limit=60");
  });
});
