import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@gennety/shared";

/**
 * The line the chat agent falls back to when the model gives it nothing.
 *
 * It used to be a hardcoded English sentence. On an ordinary turn — an OpenAI
 * call that fails, a completion with no choices, a tool loop that runs out of
 * rounds — a Russian-speaking user got an English apology out of nowhere,
 * which reads exactly like the bot switching languages on its own. The menu
 * agent had already fixed the same defect and written down why.
 */

const messageCreate = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    message: {
      create: messageCreate,
      findMany: vi.fn(async () => []),
    },
    user: { findUnique: userFindUnique },
  },
}));
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: vi.fn() }));
vi.mock("./openai-fetch.js", () => ({ openaiFetch: vi.fn() }));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: vi.fn(),
  attachChatProfilePhoto: vi.fn(),
}));
// Промпт и общий набор инструментов — предмет `chat-agent-tools.test.ts`;
// здесь они только мешают, а настоящий `buildSystemPrompt` потянул бы за собой
// пол-базы.
vi.mock("./prompt-builder.js", () => ({
  buildSystemPrompt: vi.fn(async () => "SYSTEM"),
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [],
  TOOL_KINDS: {},
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: () => false,
  executeAgentTool: vi.fn(),
}));

const { runChatTurn } = await import("./chat-agent.js");

const USER = "11111111-1111-4111-8111-111111111111";

/** A 200 whose body carries no choices — the model answered with nothing. */
const emptyCompletion: typeof fetch = (async () =>
  new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

beforeEach(() => {
  messageCreate.mockReset().mockImplementation(async ({ data }) => ({
    id: "m1",
    content: data.content,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  }));
  userFindUnique.mockReset();
});

describe("chat agent fallback", () => {
  it("answers in the user's language when the model returns nothing", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });

    const result = await runChatTurn(
      { userId: USER, text: "привет", imageUrl: null },
      { fetchFn: emptyCompletion },
    );

    expect(result.content).toBe(t("ru", "agentFallbackError"));
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: USER },
      select: { telegramId: true, language: true },
    });
  });

  it("falls back to English when the account has no language yet", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: null });

    const result = await runChatTurn(
      { userId: USER, text: "hi", imageUrl: null },
      { fetchFn: emptyCompletion },
    );

    expect(result.content).toBe(t("en", "agentFallbackError"));
  });

  /**
   * Прежняя редакция требовала НОЛЬ запросов на здоровом ходу: язык искался
   * только в аварийной ветке. С подключением общего набора инструментов ход
   * читает аккаунт всегда — исполнителям нужен `telegramId`. Требование
   * поэтому изменилось на то, которое и было ценным: запрос ОДИН, а не два.
   * Язык берётся из него же, отдельного похода в базу за ним больше нет.
   */
  it("читает аккаунт ровно один раз за ход", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    const reply: typeof fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Привет!" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await runChatTurn(
      { userId: USER, text: "привет", imageUrl: null },
      { fetchFn: reply },
    );

    expect(result.content).toBe("Привет!");
    expect(userFindUnique).toHaveBeenCalledTimes(1);
  });
});
