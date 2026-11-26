import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * App audit 2026-11-15 inside a chat turn: the shared prompt is asked for the
 * app's surface (item 1), `get_my_date` is offered and dispatched (item 3),
 * `open_screen` knows the app-only «My wishlist» (item 8), and a chat longer
 * than the window carries its own summary (item 7).
 */

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";

const messageCreate = vi.fn(async (a: { data: { content: string } }) => ({
  id: "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-11-15T10:00:00Z"),
}));
let historyRows: unknown[] = [];
let chatCount = 0;
let session: { summary: string | null; summarizedAtCount: number } | null = null;
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ telegramId: 4242n, language: "ru", profile: { homeCityKey: null } }) },
    message: {
      create: (a: { data: { content: string } }) => messageCreate(a),
      findMany: async () => historyRows,
      delete: async () => undefined,
      count: async () => chatCount,
    },
    chatSession: { findUnique: async () => session },
  },
}));

const executeAgentTool = vi.fn(async (_tg: bigint, _name: string, _args: unknown) => ({
  result: JSON.stringify({ success: true }),
  receiptKey: null,
  action: null,
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [
    {
      type: "function",
      function: {
        name: "open_screen",
        description: "Give the user a button.",
        parameters: { type: "object", properties: { screen: { type: "string", enum: ["profile", "help"] } }, required: ["screen"] },
      },
    },
  ],
  TOOL_KINDS: { open_screen: "open" },
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: (r: string) => JSON.parse(r).success === true,
  executeAgentTool: (tg: bigint, name: string, args: unknown) => executeAgentTool(tg, name, args),
}));
const buildSystemPrompt = vi.fn(async (_tg: bigint, _surface?: string) => "ОБЩИЙ ПРОМПТ");
vi.mock("./prompt-builder.js", () => ({
  buildSystemPrompt: (tg: bigint, surface?: string) => buildSystemPrompt(tg, surface),
  buildSystemPromptParts: async (tg: bigint, surface?: string) => ({ stable: await buildSystemPrompt(tg, surface), live: "" }),
}));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: async () => ({ ok: true }),
  attachChatProfilePhoto: async () => ({ ok: true }),
}));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async (path: string) => `https://signed/${path}` }));
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s1",
  touchChatSession: async () => undefined,
}));
const afterChatTurn = vi.fn();
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: (input: unknown) => afterChatTurn(input) }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));
const executeGetMyDate = vi.fn(async (_userId: string) => JSON.stringify({ success: true, scheduled: true }));
vi.mock("./chat-date-tool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-date-tool.js")>()),
  executeGetMyDate: (userId: string) => executeGetMyDate(userId),
}));

type Sent = {
  tools: Array<{ function: { name: string; parameters?: { properties?: { screen?: { enum?: string[] } } } } }>;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
};
let queue: unknown[] = [];
const sent: Sent[] = [];
const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)) as Sent);
  return { ok: true, json: async () => queue.shift() ?? plain };
}) as unknown as typeof fetch;

function calls(list: Array<{ name: string; args?: string }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: list.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: c.args ?? "{}" } })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}
const plain = { choices: [{ message: { role: "assistant", content: "готово." }, finish_reason: "stop" }] };
const consent = async () => true;

const { runChatTurn } = await import("./chat-agent.js");

beforeEach(() => {
  queue = [];
  sent.length = 0;
  historyRows = [];
  chatCount = 1;
  session = null;
  env.WISHLIST_FEATURE_ENABLED = true;
  messageCreate.mockClear();
  executeAgentTool.mockClear();
  executeGetMyDate.mockClear();
  buildSystemPrompt.mockClear();
  afterChatTurn.mockClear();
});

// Every system message of the first call: the fixed rules, the chat summary
// and the live part before the person's message (decision 2026-11-26).
const system = () =>
  sent[0]!.messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n\n");
const toolReply = (turn: number, id = "c0") =>
  JSON.parse(String(sent[turn]!.messages.find((m) => m.role === "tool" && m.tool_call_id === id)!.content));
const turn = (text = "привет") => runChatTurn({ userId: USER, text, imageUrls: [] }, { fetchFn, consent });

describe("the app's surface", () => {
  it("asks the shared prompt for the app, not Telegram", async () => {
    await turn();
    expect(buildSystemPrompt).toHaveBeenCalledWith(4242n, "app");
  });

  it("tells the model to read the date before preparing someone for it", async () => {
    await turn();
    expect(system()).toContain("call\n  `get_my_date` first");
    expect(system()).toContain("Never invent a dress code, opening hours, prices or a menu.");
  });
});

describe("get_my_date", () => {
  it("is offered and answered by the date reader, not the shared executor", async () => {
    queue = [calls([{ name: "get_my_date" }]), plain];
    await turn("как подготовиться к свиданию?");
    expect(sent[0]!.tools.map((t) => t.function.name)).toContain("get_my_date");
    expect(executeGetMyDate).toHaveBeenCalledWith(USER);
    expect(executeAgentTool).not.toHaveBeenCalled();
    expect(toolReply(1)).toMatchObject({ success: true, scheduled: true });
  });
});

describe("open_screen: the app-only wishlist", () => {
  it("the app's enum has it, the shared one is untouched", async () => {
    await turn();
    const openScreen = sent[0]!.tools.find((t) => t.function.name === "open_screen")!;
    expect(openScreen.function.parameters!.properties!.screen!.enum).toEqual(["profile", "help", "wishlist"]);
  });

  it("opens My wishlist natively, without the shared executor", async () => {
    queue = [calls([{ name: "open_screen", args: '{"screen":"wishlist"}' }]), plain];
    const result = await turn("открой мой вишлист");
    expect(executeAgentTool).not.toHaveBeenCalled();
    expect(toolReply(1)).toMatchObject({ success: true });
    expect(result.action).toEqual({ kind: "entry_point", entry: { label: "Мой вишлист", callbackData: "menu:wishlist" } });
  });

  it("with the wishlist off it is refused and shows no button", async () => {
    env.WISHLIST_FEATURE_ENABLED = false;
    queue = [calls([{ name: "open_screen", args: '{"screen":"wishlist"}' }]), plain];
    const result = await turn("открой мой вишлист");
    expect(toolReply(1)).toMatchObject({ success: false });
    expect(result.action).toBeUndefined();
  });
});

describe("earlier in this chat", () => {
  const fullWindow = () =>
    Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `реплика ${i}`,
      imageUrl: null,
      imageUrls: [],
      attachment: null,
    }));

  it("a chat longer than the window carries its own summary", async () => {
    historyRows = fullWindow();
    chatCount = 45;
    session = { summary: "They planned a jazz evening and asked about the dress code.", summarizedAtCount: 40 };
    await turn();
    expect(system()).toContain("## Earlier in this chat");
    expect(system()).toContain('"They planned a jazz evening and asked about the dress code."');
    expect(afterChatTurn).toHaveBeenCalledWith(expect.objectContaining({ refreshSummary: false }));
  });

  it("a summary that is missing or far behind is rewritten after the reply", async () => {
    historyRows = fullWindow();
    chatCount = 45;
    session = { summary: null, summarizedAtCount: 0 };
    await turn();
    expect(system()).not.toContain("Earlier in this chat");
    expect(afterChatTurn).toHaveBeenCalledWith(expect.objectContaining({ refreshSummary: true }));
  });

  it("a chat that fits the window reads nothing more", async () => {
    historyRows = fullWindow().slice(0, 5);
    chatCount = 5;
    session = { summary: "whatever", summarizedAtCount: 0 };
    await turn();
    expect(system()).not.toContain("Earlier in this chat");
    expect(afterChatTurn).toHaveBeenCalledWith(expect.objectContaining({ refreshSummary: false }));
  });
});
