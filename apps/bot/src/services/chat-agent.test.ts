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
const messageFindMany = vi.fn(async () => [] as unknown[]);

vi.mock("@gennety/db", () => ({
  prisma: {
    message: {
      create: messageCreate,
      findMany: messageFindMany,
    },
    user: { findUnique: userFindUnique },
  },
}));
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
const signedUrl = vi.fn(async (path: string) => `https://signed.example/${path}`);
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: signedUrl }));
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
const continueOrOpenChatSession = vi.fn(async (_userId: string) => LEGACY_SESSION);
const touchChatSession = vi.fn(async (_id: string, _at: Date) => undefined);
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: (userId: string) => continueOrOpenChatSession(userId),
  touchChatSession: (id: string, at: Date) => touchChatSession(id, at),
}));
const afterChatTurn = vi.fn();
vi.mock("./chat-session-digest.js", () => ({
  afterChatTurn: (input: unknown) => afterChatTurn(input),
}));

const { runChatTurn } = await import("./chat-agent.js");

const USER = "11111111-1111-4111-8111-111111111111";
const LEGACY_SESSION = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";

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
  messageFindMany.mockReset().mockResolvedValue([]);
  signedUrl.mockClear();
  continueOrOpenChatSession.mockClear();
  touchChatSession.mockClear();
  afterChatTurn.mockClear();
});

/**
 * Chat sessions (decision journal 2026-09-30): a turn belongs to ONE chat, and
 * the model sees that chat alone.
 */
describe("chat agent sessions", () => {
  const reply: typeof fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "Ок" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  it("writes both rows into the named chat and reads only that chat", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });

    const result = await runChatTurn(
      { userId: USER, text: "привет", imageUrls: [], sessionId: CHAT },
      { fetchFn: reply },
    );

    expect(result.sessionId).toBe(CHAT);
    expect(continueOrOpenChatSession).not.toHaveBeenCalled();
    const rows = messageCreate.mock.calls.map(
      ([arg]) => (arg as { data: { role: string; sessionId: string } }).data,
    );
    expect(rows.map((r) => [r.role, r.sessionId])).toEqual([
      ["user", CHAT],
      ["assistant", CHAT],
    ]);
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, sessionId: CHAT } }),
    );
  });

  it("moves the chat's updatedAt to the reply and hands the digest the turn", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "привет", imageUrl: null, imageUrls: [], context: null },
    ]);

    const result = await runChatTurn(
      { userId: USER, text: "привет", imageUrls: [], sessionId: CHAT },
      { fetchFn: reply },
    );

    expect(touchChatSession).toHaveBeenCalledWith(CHAT, result.createdAt);
    expect(afterChatTurn).toHaveBeenCalledWith({
      userId: USER,
      sessionId: CHAT,
      openedNewSession: true,
    });
  });

  it("an ongoing chat is not a new one", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "раньше", imageUrl: null, imageUrls: [], context: null },
      { role: "assistant", content: "ответ", imageUrl: null, imageUrls: [], context: null },
      { role: "user", content: "сейчас", imageUrl: null, imageUrls: [], context: null },
    ]);

    await runChatTurn(
      { userId: USER, text: "сейчас", imageUrls: [], sessionId: CHAT },
      { fetchFn: reply },
    );

    expect(afterChatTurn).toHaveBeenCalledWith(expect.objectContaining({ openedNewSession: false }));
  });

  it("an older build that names no chat lands where the six-hour rule says", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });

    const result = await runChatTurn(
      { userId: USER, text: "привет", imageUrls: [] },
      { fetchFn: reply },
    );

    expect(continueOrOpenChatSession).toHaveBeenCalledWith(USER);
    expect(result.sessionId).toBe(LEGACY_SESSION);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sessionId: LEGACY_SESSION, role: "user" }),
      }),
    );
  });

  it("tells the model other chats are out of context and how to reach them", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    const seen: Array<{
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string } }>;
    }> = [];
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await runChatTurn(
      { userId: USER, text: "помнишь?", imageUrls: [], sessionId: CHAT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    const system = seen[0]!.messages[0]!.content;
    expect(system).toContain("## Earlier chats");
    expect(system).toContain("search_past_chats");
    expect(seen[0]!.tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["search_past_chats", "read_past_chat"]),
    );
  });
});

describe("chat agent fallback", () => {
  it("answers in the user's language when the model returns nothing", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });

    const result = await runChatTurn(
      { userId: USER, text: "привет", imageUrls: [] },
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
      { userId: USER, text: "hi", imageUrls: [] },
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
      { userId: USER, text: "привет", imageUrls: [] },
      { fetchFn: reply },
    );

    expect(result.content).toBe("Привет!");
    expect(userFindUnique).toHaveBeenCalledTimes(1);
  });
});

/**
 * Альбом: снимки хода уходят модели ОДНИМ сообщением, каждый со своим токеном
 * сразу за кадром, и ответ на них один. До 2026-09-21 ход нёс одну картинку, и
 * несколько снимков были бы несколькими ходами — то есть несколькими ответами.
 */
describe("chat agent images", () => {
  const fetchOf = (fn: ReturnType<typeof vi.fn>): typeof fetch =>
    fn as unknown as typeof fetch;

  it("shows every photo of the last turn, each followed by its own token", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      {
        role: "user",
        content: "какое лучше?",
        imageUrl: `${USER}/1.jpg`,
        imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`],
        context: null,
      },
    ]);
    const seen: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).messages);
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await runChatTurn(
      { userId: USER, text: "какое лучше?", imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`] },
      { fetchFn: fetchOf(fetchFn) },
    );

    const messages = seen[0] as Array<{ role: string; content: unknown }>;
    const turn = messages.at(-1)!;
    const parts = turn.content as Array<{ type: string; text?: string }>;
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(2);
    expect(parts.map((part) => part.text).filter(Boolean)).toEqual([
      "какое лучше?",
      `[imageUrl=${USER}/1.jpg]`,
      `[imageUrl=${USER}/2.jpg]`,
    ]);
    // Порядок: подпись, кадр, токен кадра, кадр, токен кадра.
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "image_url",
      "text",
      "image_url",
      "text",
    ]);
  });

  /// Строки, написанные до списка, несут один путь — и читаются так же.
  it("reads a legacy row with only imageUrl as a single photo", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "вот", imageUrl: `${USER}/1.jpg`, imageUrls: [], context: null },
    ]);
    const seen: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).messages);
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await runChatTurn({ userId: USER, text: "вот", imageUrls: [] }, { fetchFn: fetchOf(fetchFn) });

    const messages = seen[0] as Array<{ role: string; content: unknown }>;
    const parts = messages.at(-1)!.content as Array<{ type: string }>;
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(1);
  });

  it("stores the first photo in imageUrl and all of them in imageUrls", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    await runChatTurn(
      { userId: USER, text: "вот", imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`] },
      { fetchFn: emptyCompletion },
    );
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          imageUrl: `${USER}/1.jpg`,
          imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`],
        }),
      }),
    );
  });
});
