import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reactions inside a chat turn (decision 2026-11-24): which turns get `react`,
 * the turn that ends in a reaction and no reply, the person's reaction in the
 * next turn's prompt — and that a build without `reactions` always gets words.
 * The guard and the person's endpoint are in `chat-reactions.test.ts`.
 */

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: false, AGENT_CONCEPT_ENABLED: false, AGENT_REACTIONS_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";

const messageCreate = vi.fn(async (a: { data: { role: string; content: string } }) => ({
  id: a.data.role === "user" ? "u-this" : "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-11-24T10:00:00Z"),
}));
const messageUpdate = vi.fn(async (_a: { where: { id: string }; data: Record<string, unknown> }) => ({}));
const messageDelete = vi.fn(async () => undefined);
let historyRows: Array<Record<string, unknown>> = [];
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ telegramId: 4242n, language: "ru", profile: { homeCityKey: null } }) },
    message: {
      create: (a: { data: { role: string; content: string } }) => messageCreate(a),
      update: (a: { where: { id: string }; data: Record<string, unknown> }) => messageUpdate(a),
      findMany: async () => historyRows,
      delete: () => messageDelete(),
    },
  },
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [],
  TOOL_KINDS: {},
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: (r: string) => JSON.parse(r).success === true,
  executeAgentTool: async () => ({ result: "{}", receiptKey: null, action: null }),
}));
vi.mock("./prompt-builder.js", () => ({ buildSystemPrompt: async () => "ОБЩИЙ ПРОМПТ" }));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: async () => ({ ok: true }),
  attachChatProfilePhoto: async () => ({ ok: true }),
}));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async (path: string) => `https://signed/${path}` }));
const touchChatSession = vi.fn(async () => undefined);
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s1",
  touchChatSession: () => touchChatSession(),
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));

type Facts = Awaited<ReturnType<typeof import("./chat-reactions.js").loadAgentReactionFacts>>;
let facts: Facts;
vi.mock("./chat-reactions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chat-reactions.js")>();
  return { ...original, loadAgentReactionFacts: async () => facts };
});

type Sent = { tools: Array<{ function: { name: string; parameters?: { properties?: { emoji?: { enum?: string[] } } } } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
let queue: unknown[] = [];
const sent: Sent[] = [];
const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)) as Sent);
  return { ok: true, json: async () => queue.shift() ?? line("Пожалуйста!") };
}) as unknown as typeof fetch;

function calls(list: Array<{ name: string; args?: unknown }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: list.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}
function line(content: string) {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}
const consent = async () => true;

const { runChatTurn } = await import("./chat-agent.js");
const { isReactionTurn } = await import("./chat-reactions.js");
const CARDS = new Set(["reactions"]);

beforeEach(() => {
  queue = [];
  sent.length = 0;
  env.AGENT_REACTIONS_ENABLED = true;
  historyRows = [
    { id: "u0", role: "user", content: "где выпить кофе?", imageUrl: null, imageUrls: [] },
    { id: "a0", role: "assistant", content: "«Зерно» на Подоле — тихо и вкусно.", imageUrl: null, imageUrls: [] },
    { id: "u-this", role: "user", content: "ок, спасибо", imageUrl: null, imageUrls: [] },
  ];
  facts = {
    recentUser: [{ content: "ок, спасибо", agentReaction: null }, { content: "где выпить кофе?", agentReaction: null }],
    previousAssistant: { content: "«Зерно» на Подоле — тихо и вкусно.", openOffer: false },
    safetyLatched: false,
  };
  messageCreate.mockClear();
  messageUpdate.mockClear();
  touchChatSession.mockClear();
});

const toolNames = () => sent[0]!.tools.map((tool) => tool.function.name);
const system = () => String(sent[0]!.messages[0]!.content);
const assistantCreates = () => messageCreate.mock.calls.filter((c) => c[0].data.role === "assistant");

describe("which turns get react", () => {
  it("a closing on a build that draws reactions: the tool with 🙏 👍 ❤ and its rules", async () => {
    await runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [], chatCards: CARDS, reactionsDrawn: true }, { fetchFn, consent });
    expect(toolNames()).toContain("react");
    const react = sent[0]!.tools.find((tool) => tool.function.name === "react")!;
    expect(react.function.parameters?.properties?.emoji?.enum).toEqual(["🙏", "👍", "❤"]);
    expect(system()).toContain("Reacting instead of a reply");
  });

  it("a question is not a closing: no tool, no rules", async () => {
    await runChatTurn({ userId: USER, text: "а где поесть?", imageUrls: [], chatCards: CARDS, reactionsDrawn: true }, { fetchFn, consent });
    expect(toolNames()).not.toContain("react");
    expect(system()).not.toContain("Reacting instead of a reply");
  });

  it("Gennety reacted on the person's previous message: no tool now", async () => {
    facts = { ...facts, recentUser: [{ content: "ок, спасибо", agentReaction: null }, { content: "понял", agentReaction: "👍" }] };
    await runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [], chatCards: CARDS, reactionsDrawn: true }, { fetchFn, consent });
    expect(toolNames()).not.toContain("react");
  });

  it("an older build (no `reactions`): no tool, a stray call refused, and the turn always has a message", async () => {
    queue = [calls([{ name: "react", args: { emoji: "🙏" } }]), line("Пожалуйста!")];
    const turn = await runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [] }, { fetchFn, consent });
    expect(toolNames()).not.toContain("react");
    const reply = JSON.parse(String(sent[1]!.messages.find((m) => m.role === "tool")!.content));
    expect(reply).toMatchObject({ success: false, error: "unknown_tool" });
    expect(isReactionTurn(turn)).toBe(false);
    expect(turn.content).toBe("Пожалуйста!");
    expect(turn.agentReaction).toBeUndefined();
    expect(messageUpdate).not.toHaveBeenCalled();
  });

  it("an older build where the model writes nothing after a stray react: no silent turn, the turn fails as before", async () => {
    queue = [calls([{ name: "react", args: { emoji: "🙏" } }]), line(""), line(""), line("")];
    await expect(runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [] }, { fetchFn, consent })).rejects.toThrow();
    expect(messageUpdate).not.toHaveBeenCalled();
  });
});

describe("the turn that ends in a reaction", () => {
  it("reacted and wrote nothing: no assistant row, the emoji on the person's row", async () => {
    queue = [calls([{ name: "react", args: { emoji: "🙏" } }]), line("")];
    const turn = await runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [], chatCards: CARDS, reactionsDrawn: true }, { fetchFn, consent });
    expect(isReactionTurn(turn)).toBe(true);
    expect(turn).toEqual({ kind: "reaction", sessionId: "s1", userMessageId: "u-this", agentReaction: { messageId: "u-this", emoji: "🙏" } });
    expect(assistantCreates()).toHaveLength(0);
    expect(messageUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u-this" }, data: expect.objectContaining({ agentReaction: "🙏" }) }));
    expect(touchChatSession).toHaveBeenCalled();
  });

  it("reacted and also wrote a line: both, `agentReaction` beside the message", async () => {
    queue = [calls([{ name: "react", args: { emoji: "❤️" } }]), line("Хорошего кофе!")];
    const turn = await runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [], chatCards: CARDS, reactionsDrawn: true }, { fetchFn, consent });
    expect(isReactionTurn(turn)).toBe(false);
    if (isReactionTurn(turn)) return;
    expect(turn.content).toBe("Хорошего кофе!");
    expect(turn.userMessageId).toBe("u-this");
    expect(turn.agentReaction).toEqual({ messageId: "u-this", emoji: "❤" });
    expect(assistantCreates()).toHaveLength(1);
  });

  it("an emoji the occasion does not allow is refused and the agent answers in words", async () => {
    queue = [calls([{ name: "react", args: { emoji: "🔥" } }]), line("Обращайся.")];
    const turn = await runChatTurn({ userId: USER, text: "ок, спасибо", imageUrls: [], chatCards: CARDS, reactionsDrawn: true }, { fetchFn, consent });
    const reply = JSON.parse(String(sent[1]!.messages.find((m) => m.role === "tool")!.content));
    expect(reply).toMatchObject({ success: false, error: "emoji_not_allowed" });
    expect(isReactionTurn(turn)).toBe(false);
    if (isReactionTurn(turn)) return;
    expect(turn.content).toBe("Обращайся.");
    expect(turn.agentReaction).toBeUndefined();
    expect(messageUpdate).not.toHaveBeenCalled();
  });
});

describe("the person's reaction in the next turn's prompt", () => {
  // The window is read newest first (`orderBy desc`), as Prisma returns it.
  beforeEach(() => {
    historyRows = [
      { id: "u0", role: "user", content: "где послушать джаз?", imageUrl: null, imageUrls: [], createdAt: new Date("2026-11-24T09:00:00Z") },
      {
        id: "a0",
        role: "assistant",
        content: "Бар с джазом на Подоле — живая музыка по четвергам.",
        imageUrl: null,
        imageUrls: [],
        createdAt: new Date("2026-11-24T09:00:01Z"),
        userReaction: "❤",
        reactedAt: new Date("2026-11-24T09:05:00Z"),
      },
      { id: "u-this", role: "user", content: "а в субботу?", imageUrl: null, imageUrls: [], createdAt: new Date("2026-11-24T09:06:00Z") },
    ].reverse();
  });

  it("names it with a piece of the reply and says a reaction is not a yes", async () => {
    await runChatTurn({ userId: USER, text: "а в субботу?", imageUrls: [] }, { fetchFn, consent });
    expect(system()).toContain("They reacted ❤ to your message «Бар с джазом на Подоле — живая музыка по четвергам.»");
    expect(system()).toContain("A reaction is not a reply and not a yes");
    const assistant = sent[0]!.messages.find((m) => m.role === "assistant");
    expect(String(assistant!.content)).toContain("[They reacted ❤ to this message.]");
  });

  it("with the feature off the model hears nothing about it", async () => {
    env.AGENT_REACTIONS_ENABLED = false;
    await runChatTurn({ userId: USER, text: "а в субботу?", imageUrls: [] }, { fetchFn, consent });
    expect(system()).not.toContain("They reacted");
  });

  it("Gennety's own earlier reaction is a note on that message of theirs", async () => {
    historyRows = [
      { id: "u0", role: "user", content: "понял", imageUrl: null, imageUrls: [], agentReaction: "👍" },
      { id: "u-this", role: "user", content: "а ещё вопрос", imageUrl: null, imageUrls: [] },
    ].reverse();
    await runChatTurn({ userId: USER, text: "а ещё вопрос", imageUrls: [] }, { fetchFn, consent });
    const first = sent[0]!.messages.find((m) => m.role === "user");
    expect(String(first!.content)).toContain("[You reacted 👍 to this message.]");
  });
});
