import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cache-friendly request layout (decision 2026-11-26, parts 2 and 3).
 *
 * The provider reuses the leading system message together with the tools as
 * one block, only when it is identical. So the request goes: fixed rules →
 * history → live data → the person's message, and on a chat's first turn the
 * live part follows their message so it never joins that block. The calls
 * carry a per-person `prompt_cache_key`, dropped for good the moment the API
 * refuses it.
 */

const messageCreate = vi.fn();
const messageFindMany = vi.fn();
const messageCount = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    message: {
      create: messageCreate,
      delete: vi.fn(async () => ({})),
      findMany: messageFindMany,
      count: messageCount,
    },
    user: { findUnique: userFindUnique },
    chatSession: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test", LLM_PROMPT_CACHE_KEY: true } }));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async (path: string) => `https://signed.example/${path}` }));
vi.mock("./openai-fetch.js", () => ({ openaiFetch: vi.fn() }));
vi.mock("./chat-profile-tools.js", () => ({ applyChatProfilePatch: vi.fn(), attachChatProfilePhoto: vi.fn() }));
vi.mock("./prompt-builder.js", () => ({
  buildSystemPrompt: async () => "STABLE RULES\n\nLIVE CONTEXT",
  buildSystemPromptParts: async () => ({ stable: "STABLE RULES", live: "LIVE CONTEXT" }),
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [],
  TOOL_KINDS: {},
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: () => false,
  executeAgentTool: vi.fn(),
}));
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => CHAT,
  touchChatSession: async () => undefined,
}));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => "## About this person\n- PERSON CARD" }));
vi.mock("./chat-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-consent.js")>()),
  personConsented: async () => true,
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: vi.fn() }));

const { runChatTurn, promptCacheKey } = await import("./chat-agent.js");
const { LIVE_PART_HEADER } = await import("./prompt-layout.js");

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "44444444-4444-4444-8444-444444444444";

/** `total` rows of one chat, newest first, the newest being this turn's message. */
function chatRows(total: number) {
  return Array.from({ length: total }, (_, k) => {
    const index = total - 1 - k;
    return {
      id: `r${index}`,
      role: k % 2 === 0 ? "user" : "assistant",
      content: index === total - 1 ? "сейчас" : `сообщение ${index}`,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
      imageUrl: null,
      imageUrls: [],
      attachment: null,
      context: null,
      sessionId: CHAT,
    };
  });
}

let rows: ReturnType<typeof chatRows> = [];
let sent: Array<{ messages: Array<{ role: string; content: unknown }>; prompt_cache_key?: string }> = [];
let replies: Response[] = [];

const fetchFn = (async (_url: unknown, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return (
    replies.shift() ??
    new Response(JSON.stringify({ choices: [{ message: { content: "ок" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}) as unknown as typeof fetch;

const turn = () => runChatTurn({ userId: USER, text: "сейчас", imageUrls: [], sessionId: CHAT }, { fetchFn });
const historyTexts = () =>
  sent[0]!.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => String(m.content));

beforeEach(() => {
  sent = [];
  replies = [];
  rows = chatRows(4);
  messageCreate.mockReset().mockImplementation(async ({ data }) => ({
    id: "new",
    content: data.content,
    createdAt: new Date("2026-11-26T12:00:00.000Z"),
  }));
  messageFindMany.mockReset().mockImplementation(async (args: { take?: number }) => rows.slice(0, args?.take ?? rows.length));
  messageCount.mockReset().mockImplementation(async () => rows.length);
  userFindUnique.mockReset().mockResolvedValue({ telegramId: 1n, language: "ru" });
});

describe("request layout", () => {
  it("fixed rules first, live data right before the person's message", async () => {
    await turn();
    const messages = sent[0]!.messages;
    const first = String(messages[0]!.content);
    expect(messages[0]!.role).toBe("system");
    expect(first.startsWith("STABLE RULES")).toBe(true);
    expect(first).not.toContain("LIVE CONTEXT");
    expect(first).not.toContain("PERSON CARD");

    const last = messages[messages.length - 1]!;
    const live = messages[messages.length - 2]!;
    expect(last).toMatchObject({ role: "user", content: "сейчас" });
    expect(live.role).toBe("system");
    expect(String(live.content).startsWith(LIVE_PART_HEADER)).toBe(true);
    expect(String(live.content)).toContain("LIVE CONTEXT");
    expect(String(live.content)).toContain("PERSON CARD");
    // The history sits between the two, untouched.
    expect(messages.slice(1, -2).map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  });
});

describe("history window", () => {
  it.each([
    [4, 4],
    [30, 30],
    [45, 30],
  ])("a chat of %i rows shows its newest %i", async (total, shown) => {
    rows = chatRows(total);
    await turn();
    const texts = historyTexts();
    expect(texts).toHaveLength(shown);
    expect(texts[texts.length - 1]).toBe("сейчас");
  });
});

describe("a chat's first turn", () => {
  it("keeps the live part out of the leading system message, after their message", async () => {
    rows = chatRows(1);
    await turn();
    const messages = sent[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(messages[1]).toMatchObject({ role: "user", content: "сейчас" });
    expect(String(messages[2]!.content).startsWith(LIVE_PART_HEADER)).toBe(true);
  });
});

describe("prompt_cache_key", () => {
  it("is a hash of the person, never their id", async () => {
    await turn();
    expect(sent[0]!.prompt_cache_key).toBe(promptCacheKey(USER));
    expect(sent[0]!.prompt_cache_key).not.toContain(USER);
    expect(promptCacheKey(USER)).toBe(promptCacheKey(USER));
    expect(promptCacheKey(USER)).not.toBe(promptCacheKey("22222222-2222-4222-8222-222222222222"));
  });

  it("a refusal of the parameter costs no reply and switches it off", async () => {
    replies = [
      new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: prompt_cache_key" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const result = await turn();
    expect(result.content).toBe("ок");
    expect(sent[0]!.prompt_cache_key).toBeDefined();
    expect(sent[1]!.prompt_cache_key).toBeUndefined();

    sent = [];
    await turn();
    expect(sent[0]!.prompt_cache_key).toBeUndefined();
  });
});
