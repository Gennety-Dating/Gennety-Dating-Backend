import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The «how the app works» card inside a chat turn (decision journal
 * 2026-10-29): which turns get `show_app_guide`, where the card is stored,
 * what the app gets back, what the next turn's model reads — and a Help screen
 * the app does not have is never reported as a button. The card itself is
 * tested in `chat-app-guide.test.ts`.
 */

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: false };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";

const messageCreate = vi.fn(async (a: { data: { content: string; attachment?: unknown } }) => ({
  id: "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-10-29T10:00:00Z"),
}));
let historyRows: unknown[] = [];
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ telegramId: 4242n, language: "ru", profile: { homeCityKey: null } }) },
    message: {
      create: (a: { data: { content: string } }) => messageCreate(a),
      findMany: async () => historyRows,
      delete: async () => undefined,
    },
  },
}));

const executeAgentTool = vi.fn(async (_tg: bigint, _name: string, _args: unknown) => ({
  result: JSON.stringify({ success: true }),
  receiptKey: null,
  action: { kind: "entry_point", entry: { label: "Помощь", callbackData: "menu:help" } },
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [{ type: "function", function: { name: "open_screen", parameters: {} } }],
  TOOL_KINDS: { open_screen: "open" },
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: (r: string) => JSON.parse(r).success === true,
  executeAgentTool: (tg: bigint, name: string, args: unknown) => executeAgentTool(tg, name, args),
}));
vi.mock("./prompt-builder.js", () => ({ buildSystemPrompt: async () => "ОБЩИЙ ПРОМПТ" }));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: async () => ({ ok: true }),
  attachChatProfilePhoto: async () => ({ ok: true }),
}));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async (path: string) => `https://signed/${path}` }));
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s1",
  touchChatSession: async () => undefined,
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));

let stage: string | Error = "match";
vi.mock("./chat-app-guide.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-app-guide.js")>()),
  loadGuideStage: async () => {
    if (stage instanceof Error) throw stage;
    return stage;
  },
}));

type Sent = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
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
const plain = {
  choices: [{ message: { role: "assistant", content: "ты сейчас на первом шаге: сегодня в 18:00 покажу человека." }, finish_reason: "stop" }],
};
const consent = async () => true;

const { runChatTurn } = await import("./chat-agent.js");
const GUIDE = new Set(["guide"]);

beforeEach(() => {
  queue = [];
  sent.length = 0;
  historyRows = [];
  stage = "match";
  messageCreate.mockClear();
  executeAgentTool.mockClear();
});

const toolNames = () => sent[0]!.tools.map((tool) => tool.function.name);
const system = () => String(sent[0]!.messages[0]!.content);
const toolReply = (turn: number, id = "c0") =>
  JSON.parse(String(sent[turn]!.messages.find((m) => m.role === "tool" && m.tool_call_id === id)!.content));

describe("which turns get show_app_guide", () => {
  it("a build that sends `guide`: the tool and its prompt", async () => {
    await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(toolNames()).toContain("show_app_guide");
    expect(system()).toContain("How the app works (a card under your reply)");
  });

  it("an older build: no tool, no prompt — and a stray call is refused", async () => {
    queue = [calls([{ name: "show_app_guide" }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [] }, { fetchFn, consent });
    expect(toolNames()).not.toContain("show_app_guide");
    expect(system()).not.toContain("How the app works");
    expect(toolReply(1)).toMatchObject({ success: false, error: "unknown_tool" });
    expect(turn.guide).toBeUndefined();
  });
});

describe("the card under the reply", () => {
  it("is stored on the reply and returned as `guide` with the person's stage", async () => {
    stage = "plan";
    queue = [calls([{ name: "show_app_guide" }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(toolReply(1)).toMatchObject({ success: true, here: "plan" });
    expect(turn.guide!.here).toBe("plan");
    expect(turn.guide!.steps.map((s) => s.key)).toEqual(["match", "blind", "plan", "date", "morning"]);
    expect(turn.guide!.hereLabel).toBe("ты здесь");
    expect(turn.attachment).toBeUndefined();
    expect(turn.offer).toBeUndefined();
    const stored = messageCreate.mock.calls.at(-1)![0].data.attachment as { kind: string; here: string };
    expect(stored).toMatchObject({ kind: "app_guide", here: "plan" });
  });

  it("an unreadable stage costs the «here» mark, never the card", async () => {
    stage = new Error("db down");
    queue = [calls([{ name: "show_app_guide" }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(turn.guide!.here).toBeNull();
    expect(turn.guide!.steps).toHaveLength(5);
  });

  it("one card per reply: a second call is refused", async () => {
    queue = [calls([{ name: "show_app_guide" }, { name: "show_app_guide" }]), plain];
    await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(toolReply(1, "c1")).toMatchObject({ success: false, error: "one_card_per_reply" });
  });

  it("a model that writes nothing after the card still gets one line above it", async () => {
    const empty = { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] };
    queue = [calls([{ name: "show_app_guide" }]), empty, empty];
    const turn = await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(turn.content).toBe("Вот как всё устроено:");
    expect(turn.guide).toBeDefined();
  });

  it("the next turn's model reads that the card was shown", async () => {
    historyRows = [
      { id: "u1", role: "user", content: "как это работает?", imageUrl: null, imageUrls: [] },
      {
        id: "a1",
        role: "assistant",
        content: "ты на первом шаге.",
        imageUrl: null,
        imageUrls: [],
        attachment: { kind: "app_guide", steps: [{ key: "match", title: "18:00", line: "…" }], here: "match", hereLabel: "ты здесь" },
      },
      { id: "u2", role: "user", content: "а что потом?", imageUrl: null, imageUrls: [] },
    ];
    await runChatTurn({ userId: USER, text: "а что потом?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    const assistant = sent[0]!.messages.find((m) => m.role === "assistant");
    expect(String(assistant!.content)).toContain("[Guide card under this reply: the five steps of the app, «here» on match.");
  });
});

describe("a screen the app does not have", () => {
  it.each(["help", "city", "rematch"])("open_screen('%s') is refused before it can claim a button", async (screen) => {
    queue = [calls([{ name: "open_screen", args: JSON.stringify({ screen }) }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(executeAgentTool).not.toHaveBeenCalled();
    const reply = toolReply(1);
    expect(reply).toMatchObject({ success: false, error: "no_such_screen_in_app" });
    expect(reply.instruction).toContain("call show_app_guide");
    expect(turn.action).toBeUndefined();
  });

  it("without the guide card the refusal points to words, not to the tool", async () => {
    queue = [calls([{ name: "open_screen", args: JSON.stringify({ screen: "help" }) }]), plain];
    await runChatTurn({ userId: USER, text: "как это работает?", imageUrls: [] }, { fetchFn, consent });
    expect(toolReply(1).instruction).not.toContain("show_app_guide");
  });

  it("a screen the app has still goes through", async () => {
    queue = [calls([{ name: "open_screen", args: JSON.stringify({ screen: "tickets" }) }]), plain];
    await runChatTurn({ userId: USER, text: "мои билеты", imageUrls: [], chatCards: GUIDE }, { fetchFn, consent });
    expect(executeAgentTool).toHaveBeenCalledWith(4242n, "open_screen", { screen: "tickets" });
  });
});
