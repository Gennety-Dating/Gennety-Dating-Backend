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
const messageDelete = vi.fn(async (_args: unknown) => ({}));
const userFindUnique = vi.fn();
const messageFindMany = vi.fn(async () => [] as unknown[]);

vi.mock("@gennety/db", () => ({
  prisma: {
    message: {
      create: messageCreate,
      delete: messageDelete,
      findMany: messageFindMany,
    },
    user: { findUnique: userFindUnique },
  },
}));
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
const signedUrl = vi.fn(async (path: string): Promise<string | null> => `https://signed.example/${path}`);
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
const buildPersonCard = vi.fn(async (_userId: string): Promise<string | null> => null);
vi.mock("./chat-person-card.js", () => ({
  buildPersonCard: (userId: string) => buildPersonCard(userId),
}));
vi.mock("./chat-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-consent.js")>()),
  personConsented: async () => true,
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
  messageDelete.mockClear();
  buildPersonCard.mockReset().mockResolvedValue(null);
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
    ).catch(() => undefined);

    const system = seen[0]!.messages[0]!.content;
    expect(system).toContain("## Earlier chats");
    expect(system).toContain("search_past_chats");
    expect(seen[0]!.tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["search_past_chats", "read_past_chat"]),
    );
  });
});

/**
 * Since 2026-10-15 a turn the model answered with nothing is NOT stored as a
 * canned "something went wrong" from the agent: the person's row is taken back
 * and the turn fails as unavailable (503 → the app's retry). A canned line in
 * the history was read by the next turn's model as its own words.
 */
describe("chat agent with no reply", () => {
  it("retries once, then takes the person's row back and fails as unavailable", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    const fetchFn = vi.fn(emptyCompletion);

    await expect(
      runChatTurn({ userId: USER, text: "привет", imageUrls: [] }, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "ChatAgentUnavailableError" });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(messageDelete).toHaveBeenCalledWith({ where: { id: "m1" } });
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: USER },
      select: { telegramId: true, language: true },
    });
  });

  it("a transient failure followed by an answer is an ordinary turn", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return new Response("upstream", { status: 502 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "привет" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await runChatTurn({ userId: USER, text: "привет", imageUrls: [] }, { fetchFn });

    expect(result.content).toBe("привет");
    expect(messageDelete).not.toHaveBeenCalled();
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
    ).catch(() => undefined);

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

    await runChatTurn({ userId: USER, text: "вот", imageUrls: [] }, { fetchFn: fetchOf(fetchFn) }).catch(() => undefined);

    const messages = seen[0] as Array<{ role: string; content: unknown }>;
    const parts = messages.at(-1)!.content as Array<{ type: string }>;
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(1);
  });

  it("stores the first photo in imageUrl and all of them in imageUrls", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    await runChatTurn(
      { userId: USER, text: "вот", imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`] },
      { fetchFn: emptyCompletion },
    ).catch(() => undefined);
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

/**
 * An album's photos are signed together instead of one Storage round-trip after
 * another. What the model sees, and how a Storage failure ends the turn, must
 * be what the one-by-one loop produced.
 */
describe("chat agent album signing", () => {
  const ALBUM = [`${USER}/1.jpg`, `${USER}/2.jpg`, `${USER}/3.jpg`];
  const defaultSign = async (path: string) => `https://signed.example/${path}`;

  function albumTurn() {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "вот", imageUrl: ALBUM[0], imageUrls: ALBUM, context: null },
    ]);
    const seen: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).messages);
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const run = () =>
      runChatTurn(
        { userId: USER, text: "вот", imageUrls: ALBUM },
        { fetchFn: fetchFn as unknown as typeof fetch },
      );
    const lastTurnParts = () =>
      (seen[0] as Array<{ content: unknown }>).at(-1)!.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
    return { run, lastTurnParts, fetchFn };
  }

  beforeEach(() => {
    signedUrl.mockReset().mockImplementation(defaultSign);
  });

  it("asks for every photo before any answer arrives, and keeps album order", async () => {
    const release: Array<() => void> = [];
    signedUrl.mockImplementation(
      (path: string) =>
        new Promise<string>((resolve) => {
          release.push(() => resolve(`https://signed.example/${path}`));
        }),
    );
    const { run, lastTurnParts } = albumTurn();
    const turn = run();
    await vi.waitFor(() => expect(signedUrl).toHaveBeenCalledTimes(3));
    // Answer out of order — the parts must still follow the album.
    release[2]!();
    release[0]!();
    release[1]!();
    await turn.catch(() => undefined);

    expect(signedUrl.mock.calls.map(([path]) => path)).toEqual(ALBUM);
    expect(lastTurnParts().map((part) => part.image_url?.url ?? part.text)).toEqual([
      "вот",
      `https://signed.example/${ALBUM[0]}`,
      `[imageUrl=${ALBUM[0]}]`,
      `https://signed.example/${ALBUM[1]}`,
      `[imageUrl=${ALBUM[1]}]`,
      `https://signed.example/${ALBUM[2]}`,
      `[imageUrl=${ALBUM[2]}]`,
    ]);
  });

  it("skips a photo Storage no longer has, as before", async () => {
    signedUrl.mockImplementation(async (path: string) =>
      path === ALBUM[1] ? null : `https://signed.example/${path}`,
    );
    const { run, lastTurnParts } = albumTurn();
    await run().catch(() => undefined);

    expect(lastTurnParts().filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "вот",
      `[imageUrl=${ALBUM[0]}]`,
      `[imageUrl=${ALBUM[2]}]`,
    ]);
  });

  it("fails the turn with the first photo's error in album order, without waiting on later photos", async () => {
    const first = new Error("storage timeout on photo 1");
    signedUrl.mockImplementation((path: string) => {
      if (path === ALBUM[0]) {
        return new Promise<string | null>((_resolve, reject) => setTimeout(() => reject(first), 20));
      }
      if (path === ALBUM[1]) return Promise.reject(new Error("storage refused photo 2"));
      // Photo 3 never answers: the one-by-one loop never got to it either.
      return new Promise<string | null>(() => undefined);
    });
    const { run, fetchFn } = albumTurn();

    await expect(run()).rejects.toBe(first);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/**
 * Founder's chat 2026-10-15 ("perfume"): what went wrong there, pinned down.
 */
describe("chat agent after the perfume chat", () => {
  beforeEach(() => {
    signedUrl.mockReset().mockImplementation(async (path: string) => `https://signed.example/${path}`);
  });

  type Sent = { messages: Array<{ role: string; content: unknown }>; tool_choice?: string };

  function recorder(answers: Array<() => Response>) {
    const seen: Sent[] = [];
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      const next = answers.shift();
      return next ? next() : json({ choices: [{ message: { content: "ок" }, finish_reason: "stop" }] });
    });
    return { seen, fetchFn: fetchFn as unknown as typeof fetch, calls: fetchFn };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  const toolCall = (name: string) => () =>
    json({
      choices: [
        {
          message: { content: null, tool_calls: [{ id: `c-${Math.random()}`, type: "function", function: { name, arguments: "{}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });

  it("still shows the photos of an earlier message — without attach tokens", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      // newest first, as the query returns them
      { role: "user", content: "там ещё третий", imageUrl: null, imageUrls: [], context: null },
      { role: "assistant", content: "Le Beau и Russian Tea", imageUrl: null, imageUrls: [], context: null },
      { role: "user", content: "вот духи", imageUrl: `${USER}/1.jpg`, imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`, `${USER}/3.jpg`], context: null },
    ]);
    const { seen, fetchFn } = recorder([]);

    await runChatTurn({ userId: USER, text: "там ещё третий", imageUrls: [], sessionId: CHAT }, { fetchFn });

    const earlier = seen[0]!.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && (m.content as Array<{ text?: string }>)[0]?.text === "вот духи",
    );
    const parts = earlier!.content as Array<{ type: string; text?: string }>;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(3);
    expect(parts.some((p) => p.text?.startsWith("[imageUrl="))).toBe(false);
  });

  it("an earlier photo Storage lost is reported missing instead of failing the turn", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "и?", imageUrl: null, imageUrls: [], context: null },
      { role: "user", content: "вот", imageUrl: `${USER}/1.jpg`, imageUrls: [`${USER}/1.jpg`], context: null },
    ]);
    signedUrl.mockImplementationOnce(async () => {
      throw new Error("gone");
    });
    const { seen, fetchFn } = recorder([]);

    const result = await runChatTurn({ userId: USER, text: "и?", imageUrls: [], sessionId: CHAT }, { fetchFn });

    expect(result.content).toBe("ок");
    const earlier = seen[0]!.messages[1]!.content as Array<{ type: string; text?: string }>;
    expect(earlier.some((p) => p.text?.includes("no longer shown"))).toBe(true);
  });

  it("an old canned fallback line reaches the model as a failure note, not as its own words", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "Что повторить?", imageUrl: null, imageUrls: [], context: null },
      { role: "assistant", content: t("ru", "agentFallbackError"), imageUrl: null, imageUrls: [], context: null },
    ]);
    const { seen, fetchFn } = recorder([]);

    await runChatTurn({ userId: USER, text: "Что повторить?", imageUrls: [], sessionId: CHAT }, { fetchFn });

    const assistant = seen[0]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).not.toBe(t("ru", "agentFallbackError"));
    expect(String(assistant.content)).toContain("Technical failure");
  });

  it("a turn still calling tools after every round ends with a closing call, tools off", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    const menu = await import("./menu-agent.js");
    vi.mocked(menu.executeAgentTool).mockResolvedValue({
      result: JSON.stringify({ success: true }),
      receiptKey: null,
      action: null,
    } as Awaited<ReturnType<typeof menu.executeAgentTool>>);
    const { seen, fetchFn } = recorder([
      toolCall("get_my_profile"),
      toolCall("get_my_profile"),
      toolCall("get_my_profile"),
      toolCall("get_my_profile"),
      toolCall("get_my_profile"),
      () => json({ choices: [{ message: { content: "посмотрел твой профиль" }, finish_reason: "stop" }] }),
    ]);

    const result = await runChatTurn({ userId: USER, text: "глянь профиль", imageUrls: [], sessionId: CHAT }, { fetchFn });

    expect(result.content).toBe("посмотрел твой профиль");
    expect(seen).toHaveLength(6);
    expect(seen[5]!.tool_choice).toBe("none");
    expect(seen[0]!.tool_choice).toBeUndefined();
  });

  it("a photo the provider refuses costs the photo, not the reply", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    messageFindMany.mockResolvedValue([
      { role: "user", content: "мои духи", imageUrl: `${USER}/1.jpg`, imageUrls: [`${USER}/1.jpg`], context: null },
    ]);
    const { seen, fetchFn } = recorder([
      () => new Response("invalid image", { status: 400 }),
      () => new Response("invalid image", { status: 400 }),
    ]);

    const result = await runChatTurn(
      { userId: USER, text: "мои духи", imageUrls: [`${USER}/1.jpg`], sessionId: CHAT },
      { fetchFn },
    );

    expect(result.content).toBe("ок");
    const last = seen[2]!.messages.at(-1)!.content as Array<{ type: string; text?: string }>;
    expect(last.some((p) => p.type === "image_url")).toBe(false);
    expect(last.some((p) => p.text?.includes("could not be shown"))).toBe(true);
  });

  it("strips markdown and trims a reply cut by the token ceiling to a whole sentence", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    const { fetchFn } = recorder([
      () =>
        json({
          choices: [
            {
              message: { content: "**Tobacco Memories** — тёплый выбор. Он про вечер у камина. А ещё он хорошо сочета" },
              finish_reason: "length",
            },
          ],
        }),
    ]);

    const result = await runChatTurn({ userId: USER, text: "какой лучше", imageUrls: [], sessionId: CHAT }, { fetchFn });

    expect(result.content).toBe("Tobacco Memories — тёплый выбор. Он про вечер у камина.");
  });

  it("puts the person card into the system prompt", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    buildPersonCard.mockResolvedValue("## About this person (live — read before you answer)\n- Interests: perfume");
    const { seen, fetchFn } = recorder([]);

    await runChatTurn({ userId: USER, text: "привет", imageUrls: [], sessionId: CHAT }, { fetchFn });

    expect(String(seen[0]!.messages[0]!.content)).toContain("- Interests: perfume");
  });

  it("a card that cannot be built does not cost the turn", async () => {
    userFindUnique.mockResolvedValue({ telegramId: 1n, language: "ru" });
    buildPersonCard.mockRejectedValue(new Error("db down"));
    const { fetchFn } = recorder([]);

    const result = await runChatTurn({ userId: USER, text: "привет", imageUrls: [], sessionId: CHAT }, { fetchFn });

    expect(result.content).toBe("ок");
  });
});
