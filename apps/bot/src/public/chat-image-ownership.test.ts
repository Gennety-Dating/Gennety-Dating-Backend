import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `imageUrl` ownership boundary on `POST /v1/chat/message`.
 *
 * The check used to be `imageUrl.startsWith(userId + "/")`, which is a prefix
 * test rather than a path test. The key is interpolated into the Supabase
 * object URL and `fetch` collapses dot segments before the request leaves, so
 * `<caller>/../<victim>/<ts>.jpg` passed the prefix and then addressed the
 * victim's object — readable back as a signed URL through `/v1/chat/history`
 * and copyable into the caller's profile through `attach_profile_photo`.
 */

const CALLER = "11111111-1111-4111-8111-111111111111";
const VICTIM = "22222222-2222-4222-8222-222222222222";

const runChatTurn = vi.fn();
vi.mock("../services/chat-agent.js", () => ({ runChatTurn }));
vi.mock("../services/chat-topics.js", () => ({ listChatTopics: vi.fn() }));
vi.mock("../services/storage.js", () => ({
  uploadChatImage: vi.fn(),
  createChatImageSignedUrl: vi.fn(async () => "https://signed.example/x"),
}));
vi.mock("@gennety/db", () => ({ prisma: { message: { findUnique: vi.fn(), findMany: vi.fn() } } }));
vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = CALLER;
    next();
  },
}));
vi.mock("./usage-middleware.js", () => ({
  usageGuard: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Кто допущен к агенту — предмет `chat-agent-access.test.ts`; здесь проверяется
// граница владения картинкой, и гейт нейтрализуется наравне с остальными.
vi.mock("./agent-access-middleware.js", () => ({
  requireAgentAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./rate-limit.js", () => ({
  chatMessageLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  chatUploadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  voiceLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { chatRouter } = await import("./routes/chat.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/chat", chatRouter);
  return app;
}

beforeEach(() => {
  runChatTurn.mockReset().mockResolvedValue({
    id: "m1",
    role: "assistant",
    content: "ok",
    imageUrl: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

describe("POST /v1/chat/message — imageUrl ownership", () => {
  it("accepts the caller's own upload key", async () => {
    const res = await request(buildApp())
      .post("/v1/chat/message")
      .send({ imageUrl: `${CALLER}/1750000000000.jpg` });
    expect(res.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalled();
  });

  it("refuses a traversing key that a prefix test would have accepted", async () => {
    const traversal = `${CALLER}/../${VICTIM}/1750000000000.jpg`;
    expect(traversal.startsWith(`${CALLER}/`)).toBe(true); // the old check passed
    const res = await request(buildApp())
      .post("/v1/chat/message")
      .send({ imageUrl: traversal });
    expect(res.status).toBe(403);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("refuses another user's key outright", async () => {
    const res = await request(buildApp())
      .post("/v1/chat/message")
      .send({ imageUrl: `${VICTIM}/1750000000000.jpg` });
    expect(res.status).toBe(403);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("takes several own keys in the order they were sent", async () => {
    const first = `${CALLER}/1750000000001.jpg`;
    const second = `${CALLER}/1750000000002.jpg`;
    const res = await request(buildApp())
      .post("/v1/chat/message")
      .send({ imageUrls: [second, first] });
    expect(res.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: [second, first] }));
  });

  /// Один чужой путь в списке отказывает ВСЕМУ ходу: пропустить остальные
  /// значило бы отправить сообщение, которого человек не составлял.
  it("refuses the whole turn when one key in the list is foreign", async () => {
    const res = await request(buildApp())
      .post("/v1/chat/message")
      .send({ imageUrls: [`${CALLER}/1750000000001.jpg`, `${VICTIM}/1750000000002.jpg`] });
    expect(res.status).toBe(403);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("refuses more than ten photos in one turn", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `${CALLER}/17500000000${10 + i}.jpg`);
    const res = await request(buildApp()).post("/v1/chat/message").send({ imageUrls: many });
    expect(res.status).toBe(413);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  /// Старое поле и список приходят вместе: одиночный снимок встаёт первым и
  /// не дублируется.
  it("merges imageUrl into the list without duplicating it", async () => {
    const one = `${CALLER}/1750000000001.jpg`;
    const two = `${CALLER}/1750000000002.jpg`;
    const res = await request(buildApp())
      .post("/v1/chat/message")
      .send({ imageUrl: one, imageUrls: [one, two] });
    expect(res.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: [one, two] }));
  });

  it("refuses a key with an unexpected shape under the caller's own prefix", async () => {
    for (const key of [
      `${CALLER}/nested/1750000000000.jpg`,
      `${CALLER}/1750000000000.svg`,
      `${CALLER}/`,
      `${CALLER}/..`,
    ]) {
      const res = await request(buildApp()).post("/v1/chat/message").send({ imageUrl: key });
      expect(res.status, key).toBe(403);
    }
    expect(runChatTurn).not.toHaveBeenCalled();
  });
});
