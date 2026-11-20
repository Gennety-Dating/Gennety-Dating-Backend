import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vibe card inside a chat turn (decision 2026-11-21): which turns get
 * `show_vibe_card`, the prompt block after the concept block, where the card
 * is stored, what the app gets back — and that the line after it may be empty.
 * The card itself is tested in `chat-vibe-card.test.ts`.
 */

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: false, AGENT_VIBE_CARDS_ENABLED: true, AGENT_CONCEPT_ENABLED: false };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";

const messageCreate = vi.fn(async (a: { data: { content: string; attachment?: unknown } }) => ({
  id: "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-11-21T10:00:00Z"),
}));
let historyRows: Array<Record<string, unknown>> = [];
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
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s1",
  touchChatSession: async () => undefined,
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));

type Sent = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
let queue: unknown[] = [];
const sent: Sent[] = [];
const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)) as Sent);
  return { ok: true, json: async () => queue.shift() ?? plain };
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
const line = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const plain = line("Пальто решает половину.");
const consent = async () => true;

const AURA = {
  kind: "aura",
  personVisible: true,
  allAdults: true,
  score: 87,
  archetype: "Тихая уверенность",
  bars: { energy: 82, style: 91, frame: 74 },
  reads: ["пальто по фигуре"],
  steps: [{ text: "Телефон экраном вниз на свидании." }],
  sticker: true,
};

const { runChatTurn } = await import("./chat-agent.js");
const VIBE = new Set(["vibe"]);
const PHOTO = ["chat/u/1.jpg"];

beforeEach(() => {
  queue = [];
  sent.length = 0;
  historyRows = [{ id: "u1", role: "user", content: "какая у меня аура?", imageUrl: PHOTO[0], imageUrls: PHOTO }];
  messageCreate.mockClear();
});

const toolNames = () => sent[0]!.tools.map((tool) => tool.function.name);
const system = () => String(sent[0]!.messages[0]!.content);
const toolReply = (turn: number, id = "c0") =>
  JSON.parse(String(sent[turn]!.messages.find((m) => m.role === "tool" && m.tool_call_id === id)!.content));

describe("which turns get show_vibe_card", () => {
  it("a build that sends `vibe` and a photo: the tool and its rules, last in the prompt", async () => {
    await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    expect(toolNames()).toContain("show_vibe_card");
    expect(system()).toContain("Rating a photo — the vibe card");
    expect(system().trimEnd().endsWith("short, specific to THIS photo.")).toBe(true);
  });

  it("no photo on this turn: no tool, no rules", async () => {
    historyRows = [{ id: "u1", role: "user", content: "какая у меня аура?", imageUrl: null, imageUrls: [] }];
    await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: [], chatCards: VIBE }, { fetchFn, consent });
    expect(toolNames()).not.toContain("show_vibe_card");
    expect(system()).not.toContain("vibe card");
  });

  it("an older build: no tool — and a stray call is refused", async () => {
    queue = [calls([{ name: "show_vibe_card", args: AURA }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: PHOTO }, { fetchFn, consent });
    expect(toolNames()).not.toContain("show_vibe_card");
    expect(toolReply(1)).toMatchObject({ success: false, error: "unknown_tool" });
    expect(turn.vibe).toBeUndefined();
  });

  it("distress words in the chat: safety mode, no tool", async () => {
    historyRows = [{ id: "u1", role: "user", content: "я урод, скажи честно сколько из 100", imageUrl: PHOTO[0], imageUrls: PHOTO }];
    await runChatTurn({ userId: USER, text: "я урод, скажи честно сколько из 100", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    expect(toolNames()).not.toContain("show_vibe_card");
  });
});

describe("the card", () => {
  it("is stored on the reply and returned as `vibe` + `sticker`", async () => {
    queue = [calls([{ name: "show_vibe_card", args: AURA }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    expect(toolReply(1)).toMatchObject({ success: true });
    expect(turn.vibe).toMatchObject({ kind: "aura", score: 87, title: "Аура", archetype: "Тихая уверенность" });
    expect(turn.sticker).toEqual({ id: "aura", caption: "+1000 AURA" });
    expect(turn.content).toBe("Пальто решает половину.");
    const stored = messageCreate.mock.calls.at(-1)![0].data.attachment as { kind: string; cardKind: string };
    expect(stored).toMatchObject({ kind: "vibe_card", cardKind: "aura" });
  });

  it("a reply with no line after the card is fine — the card is the answer", async () => {
    queue = [calls([{ name: "show_vibe_card", args: { ...AURA, sticker: false } }]), line("")];
    const turn = await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    expect(turn.content).toBe("");
    expect(turn.vibe).toBeDefined();
    expect(turn.sticker).toBeUndefined();
  });

  it("a possible minor: refused, no card", async () => {
    queue = [calls([{ name: "show_vibe_card", args: { ...AURA, allAdults: false } }]), line("По этому фото не буду.")];
    const turn = await runChatTurn({ userId: USER, text: "оцени её", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    expect(toolReply(1)).toMatchObject({ success: false, error: "minor_possible" });
    expect(turn.vibe).toBeUndefined();
    expect(turn.sticker).toBeUndefined();
  });

  it("one card per reply", async () => {
    queue = [calls([{ name: "show_vibe_card", args: AURA }, { name: "show_vibe_card", args: AURA }]), plain];
    await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    expect(toolReply(1, "c1")).toMatchObject({ success: false, error: "one_card_per_reply" });
  });

  it("the next turn's model reads the card under its earlier reply", async () => {
    queue = [calls([{ name: "show_vibe_card", args: AURA }]), plain];
    await runChatTurn({ userId: USER, text: "какая у меня аура?", imageUrls: PHOTO, chatCards: VIBE }, { fetchFn, consent });
    const stored = messageCreate.mock.calls.at(-1)![0].data.attachment;
    sent.length = 0;
    historyRows = [
      { id: "u1", role: "user", content: "какая у меня аура?", imageUrl: PHOTO[0], imageUrls: PHOTO },
      { id: "a1", role: "assistant", content: "Пальто решает половину.", imageUrl: null, imageUrls: [], attachment: stored },
      { id: "u2", role: "user", content: "а почему не 90?", imageUrl: null, imageUrls: [] },
    ];
    await runChatTurn({ userId: USER, text: "а почему не 90?", imageUrls: [], chatCards: VIBE }, { fetchFn, consent });
    const assistant = sent[0]!.messages.find((m) => m.role === "assistant");
    expect(String(assistant!.content)).toContain("[Aura card above this reply: 87, «Тихая уверенность»");
  });
});
