import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and the agent-access rule.
 *
 * The rule itself is tested in `services/agent-access.test.ts`; what is tested
 * here is that this router ASKS it. That distinction is the whole point: the
 * rule was already correct and already enforced on the two Telegram-facing
 * doors, and the mobile chat surface still let a banned account run LLM turns
 * and write its profile, because nobody wired the question up. A test on the
 * rule alone would have stayed green through that.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = { JWT_SECRET, LLM_TOKEN_BUDGET_ENABLED: false, OPENAI_API_KEY: "k" };
vi.mock("../../config.js", () => ({ env }));

/** Мок повторяет настоящую сигнатуру, а не нулевую арность (образец — `client-events.test.ts`). */
const findUnique = vi.fn(async (_args: unknown): Promise<unknown> => account());
const messageFindMany = vi.fn(async (_args: unknown): Promise<unknown[]> => []);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (args: unknown) => findUnique(args) },
    message: {
      findMany: (args: unknown) => messageFindMany(args),
      findUnique: async () => null,
    },
  },
}));

const runChatTurn = vi.fn(async (_input: unknown) => ({
  id: "m1",
  role: "assistant" as const,
  content: "hi",
  imageUrl: null,
  createdAt: new Date("2026-09-07T10:00:00Z"),
}));
vi.mock("../../services/chat-agent.js", () => ({
  runChatTurn: (input: unknown) => runChatTurn(input),
}));

vi.mock("../../services/chat-topics.js", () => ({
  listChatTopics: async () => [],
}));

const uploadChatImage = vi.fn(
  async (_userId: string, _buf: Buffer, _mime: string) => ({ path: "p" }),
);
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: (userId: string, buf: Buffer, mime: string) =>
    uploadChatImage(userId, buf, mime),
  createChatImageSignedUrl: async () => "https://signed.example/x",
}));

const { chatRouter } = await import("./chat.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/chat", chatRouter);
  return app;
}

function token(sub: string): string {
  return jwt.sign({ sub, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
}

/** The shape `requireAgentAccess` selects — nothing else is read. */
function account(over: Record<string, unknown> = {}) {
  return {
    status: "active",
    onboardingStep: "completed",
    suspendedUntil: null,
    ...over,
  };
}

function post(path: string, body: object = { text: "привет" }) {
  return request(buildApp())
    .post(path)
    .set("Authorization", `Bearer ${token(USER_ID)}`)
    .send(body);
}

beforeEach(() => {
  runChatTurn.mockClear();
  uploadChatImage.mockClear();
  findUnique.mockReset();
  findUnique.mockResolvedValue(account());
});

describe("POST /v1/chat/message — кто вообще допущен к агенту", () => {
  it("активный онбордившийся проходит и получает ход агента", async () => {
    const res = await post("/v1/chat/message");

    expect(res.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledOnce();
  });

  // Каждое из трёх модерационных состояний проверяется отдельно: они приходят
  // из разных мест продукта, и «одно из них случайно не в словаре» — ровно тот
  // отказ, который эта таблица должна ловить.
  it.each([
    ["banned", "banned"],
    ["suspended", "suspended"],
    ["pending_investigation", "under_investigation"],
  ])("%s получает 403 и НЕ доходит до модели", async (status, reason) => {
    findUnique.mockResolvedValue(account({ status }));

    const res = await post("/v1/chat/message");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: reason });
    // Главное утверждение файла: токены не потрачены, профиль не тронут.
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("держащийся за верификационной картой получает 403", async () => {
    // `status: onboarding` + `onboardingStep: completed` — это и есть гейт
    // верификации (`isVerificationGated`), а не «человек не дошёл».
    findUnique.mockResolvedValue(account({ status: "onboarding" }));

    const res = await post("/v1/chat/message");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "verification_required" });
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("недоонбордившийся получает 409 — это другой агент, не этот", async () => {
    findUnique.mockResolvedValue(account({ onboardingStep: "photos" }));

    const res = await post("/v1/chat/message");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_onboarded" });
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("токен пережил аккаунт — это отказ, а не 500", async () => {
    findUnique.mockResolvedValue(null);

    const res = await post("/v1/chat/message");

    expect(res.status).toBe(409);
    expect(runChatTurn).not.toHaveBeenCalled();
  });
});

describe("POST /v1/chat/upload — гейт стоит и на хранилище", () => {
  it("забаненный отвергается ДО multer: 403, а не 400 про отсутствующий файл", async () => {
    findUnique.mockResolvedValue(account({ status: "banned" }));

    const res = await post("/v1/chat/upload", {});

    expect(res.status).toBe(403);
    expect(uploadChatImage).not.toHaveBeenCalled();
  });
});

describe("GET /v1/chat/history — читающие маршруты намеренно открыты", () => {
  it("забаненный по-прежнему видит свою переписку", async () => {
    findUnique.mockResolvedValue(account({ status: "banned" }));

    const res = await request(buildApp())
      .get("/v1/chat/history")
      .set("Authorization", `Bearer ${token(USER_ID)}`);

    // Ни токенов, ни записи — а пустая история читалась бы как потеря данных.
    expect(res.status).toBe(200);
  });
});
