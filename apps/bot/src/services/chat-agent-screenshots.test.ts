import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The screenshot library inside a chat turn: which turns get its tools and its
 * prompt section, that with the flag off nothing changes by a byte, and that a
 * picture reaches the model in a legal position and is stored nowhere.
 * The tools themselves are tested in `screenshot-library.test.ts`.
 */

const env: Record<string, unknown> = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: false, SCREENSHOT_LIBRARY_ENABLED: false };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

const messageCreate = vi.fn(async (a: { data: { content: string; attachment?: unknown } }) => ({
  id: "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-11-01T10:00:00Z"),
}));
const libraryFind = vi.fn();
const itemFindFirst = vi.fn();
const ideaFindMany = vi.fn(async (_a: unknown) => [] as Array<{ title: string }>);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ telegramId: 4242n, language: "ru", profile: { homeCityKey: null } }) },
    message: {
      create: (a: { data: { content: string } }) => messageCreate(a),
      findMany: async () => [],
      delete: async () => undefined,
    },
    screenshotLibrary: { findUnique: (a: unknown) => libraryFind(a) },
    memoryIdea: { findMany: (a: unknown) => ideaFindMany(a) },
    memoryIdeaEvent: { create: async () => ({}) },
    wishlistItem: { findMany: async () => [] },
    screenshotItem: { findFirst: (a: unknown) => itemFindFirst(a), findMany: async () => [], count: async () => 0 },
  },
  Prisma: { sql: () => [], empty: [], join: () => [] },
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [],
  TOOL_KINDS: {},
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: () => true,
  executeAgentTool: async () => ({ result: "{}", receiptKey: null, action: null }),
}));
vi.mock("./prompt-builder.js", () => ({ buildSystemPrompt: async () => "ОБЩИЙ ПРОМПТ" }));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: async () => ({ ok: true }),
  attachChatProfilePhoto: async () => ({ ok: true }),
}));
vi.mock("./storage.js", () => ({
  createChatImageSignedUrl: async (path: string) => `https://signed/${path}`,
  createScreenshotSignedUrls: async (paths: string[]) => paths.map((p) => `https://signed/${p}`),
}));
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s1",
  touchChatSession: async () => undefined,
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));

type Sent = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }> };
let queue: unknown[] = [];
const sent: Sent[] = [];
const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)) as Sent);
  return { ok: true, json: async () => queue.shift() ?? plain };
}) as unknown as typeof fetch;

function calls(list: Array<{ name: string; args?: unknown }>) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: list.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      },
      finish_reason: "tool_calls",
    }],
  };
}
const plain = { choices: [{ message: { role: "assistant", content: "ок." }, finish_reason: "stop" }] };
const consent = async () => true;

const { runChatTurn } = await import("./chat-agent.js");
const { screenshotLibraryAddendum } = await import("./chat-screenshots.js");
const CARDS = new Set(["screenshots"]);

const turn = (chatCards?: Set<string>) =>
  runChatTurn({ userId: USER, text: "куда сходить в субботу?", imageUrls: [], ...(chatCards ? { chatCards } : {}) }, { fetchFn, consent });
const system = (at = 0) => String(sent[at]!.messages[0]!.content);
const toolNames = () => sent[0]!.tools.map((tool) => tool.function.name);
const LIBRARY_TOOLS = ["search_screenshots", "read_screenshot", "view_screenshot", "show_screenshots", "check_event"];

beforeEach(() => {
  queue = [];
  sent.length = 0;
  env.SCREENSHOT_LIBRARY_ENABLED = false;
  messageCreate.mockClear();
  libraryFind.mockReset();
  itemFindFirst.mockReset();
  libraryFind.mockResolvedValue({ status: "active", generation: 1 });
});

describe("flag off changes nothing", () => {
  it("the prompt and the tools are the same bytes as a build without the card", async () => {
    await turn(CARDS);
    const flagOff = { system: system(), tools: JSON.stringify(sent[0]!.tools) };
    sent.length = 0;
    await turn();
    expect(system()).toBe(flagOff.system);
    expect(JSON.stringify(sent[0]!.tools)).toBe(flagOff.tools);
    expect(flagOff.system).not.toMatch(/screenshot library/i);
    for (const name of LIBRARY_TOOLS) expect(flagOff.tools).not.toContain(name);
    expect(libraryFind).not.toHaveBeenCalled();
  });

  it("flag on with an old build is the same bytes too", async () => {
    await turn(CARDS);
    const flagOff = system();
    sent.length = 0;
    env.SCREENSHOT_LIBRARY_ENABLED = true;
    await turn();
    expect(system()).toBe(flagOff);
    expect(libraryFind).not.toHaveBeenCalled();
  });

  it("the section is only an addition: taking it out gives the flag-off prompt", async () => {
    await turn(CARDS);
    const flagOff = system();
    sent.length = 0;
    env.SCREENSHOT_LIBRARY_ENABLED = true;
    await turn(CARDS);
    const on = system();
    const section = `\n\n${screenshotLibraryAddendum(true)}`;
    expect(on).toContain(section);
    expect(on.replace(section, "")).toBe(flagOff);
  });
});

describe("the section", () => {
  beforeEach(() => {
    env.SCREENSHOT_LIBRARY_ENABLED = true;
  });

  it("an open library: the reasons to look and the boundaries", async () => {
    await turn(CARDS);
    const text = system();
    for (const name of LIBRARY_TOOLS) expect(toolNames()).toContain(name);
    expect(text).toContain("purpose inspiration");
    expect(text).toMatch(/Saved is not wanted/);
    expect(text).toMatch(/allergy, a diet/);
    expect(text).toMatch(/first ask who it is for/);
    expect(text).toMatch(/Found is not saved/);
    expect(text).toMatch(/card with its button is the only way/);
    expect(text).toMatch(/check_event/);
  });

  it("no library: says not to look, and costs no search of anything", async () => {
    libraryFind.mockResolvedValue(null);
    await turn(CARDS);
    expect(system()).toContain("Their screenshot library (not connected)");
    expect(system()).not.toContain("purpose inspiration");
    expect(system()).toMatch(/do not bring it up/);
  });

  it("nothing of the library's content rides in the prompt", async () => {
    await turn(CARDS);
    expect(itemFindFirst).not.toHaveBeenCalled();
  });

  it("an unreadable status does not cost the turn", async () => {
    libraryFind.mockRejectedValue(new Error("db down"));
    const out = await turn(CARDS);
    expect(out.content).toBe("ок.");
    expect(system()).toContain("(not connected)");
  });
});

describe("a question about a date, not connected", () => {
  it("no card under the reply", async () => {
    env.SCREENSHOT_LIBRARY_ENABLED = true;
    libraryFind.mockResolvedValue(null);
    queue = [calls([{ name: "search_screenshots", args: { query: "date idea", purpose: "inspiration" } }]), plain];
    const out = await turn(CARDS);
    expect(out.screenshots).toBeUndefined();
    expect(messageCreate.mock.calls.at(-1)![0].data.attachment).toBeUndefined();
  });
});

describe("ideas on, with no library card", () => {
  const IDEA = "33333333-3333-4333-8333-333333333333";
  const item = { title: "Шарф", category: "gift", image: "none", ideaId: IDEA };

  beforeEach(() => {
    env.MEMORY_IDEAS_ENABLED = true;
    env.WISHLIST_FEATURE_ENABLED = true;
    ideaFindMany.mockReset();
    ideaFindMany.mockResolvedValue([]);
  });
  afterEach(() => {
    env.MEMORY_IDEAS_ENABLED = false;
    env.WISHLIST_FEATURE_ENABLED = false;
  });

  it("the event check is there, and the rest of the library is not", async () => {
    await turn();
    const names = toolNames();
    expect(names).toContain("check_event");
    expect(names).toContain("planning_ideas");
    expect(names).not.toContain("search_screenshots");
  });

  it("a gift for someone else makes no card without their exact words", async () => {
    ideaFindMany.mockResolvedValue([{ title: "Шарф" }]);
    queue = [calls([{ name: "propose_wishlist_items", args: { items: [item] } }]), plain];
    const asked: string[] = [];
    const out = await runChatTurn(
      { userId: USER, text: "вот шарф", imageUrls: [], chatCards: new Set(["wishlist"]) },
      { fetchFn, consent: async (q: { tool: string }) => { asked.push(q.tool); return false; } },
    );
    expect(asked).toContain("wishlist_from_gift_idea");
    const reply = JSON.parse(String(sent[1]!.messages.find((m) => m.role === "tool")!.content));
    expect(reply.error).toBe("gift_idea");
    expect((out as { wishlist?: unknown }).wishlist).toBeUndefined();
  });

  it("with their exact words the card shows, and it never asks about an ordinary item", async () => {
    ideaFindMany.mockResolvedValue([{ title: "Шарф" }]);
    queue = [calls([{ name: "propose_wishlist_items", args: { items: [item] } }]), plain];
    await runChatTurn({ userId: USER, text: "добавь шарф в мой вишлист", imageUrls: [], chatCards: new Set(["wishlist"]) }, { fetchFn, consent });
    const reply = JSON.parse(String(sent[1]!.messages.find((m) => m.role === "tool")!.content));
    expect(reply.success).toBe(true);

    sent.length = 0;
    ideaFindMany.mockResolvedValue([]);
    queue = [calls([{ name: "propose_wishlist_items", args: { items: [{ title: "Духи", category: "perfume", image: "none" }] } }]), plain];
    const asked: string[] = [];
    await runChatTurn(
      { userId: USER, text: "обожаю эти духи", imageUrls: [], chatCards: new Set(["wishlist"]) },
      { fetchFn, consent: async (q: { tool: string }) => { asked.push(q.tool); return true; } },
    );
    expect(asked).toEqual([]);
  });
});

describe("a picture for the model", () => {
  beforeEach(() => {
    env.SCREENSHOT_LIBRARY_ENABLED = true;
    itemFindFirst.mockResolvedValue({ id: ITEM, storagePath: `${USER}/${ITEM}.jpg`, state: "ready" });
  });

  it("follows every tool answer of its round, at low detail, with its rules", async () => {
    queue = [
      calls([{ name: "view_screenshot", args: { id: ITEM } }, { name: "read_screenshot", args: { id: ITEM } }]),
      plain,
    ];
    itemFindFirst.mockResolvedValueOnce({ id: ITEM, storagePath: `${USER}/${ITEM}.jpg`, state: "ready" });
    itemFindFirst.mockResolvedValueOnce({ id: ITEM, title: "t", description: "d", capturedAt: null, entities: [], ocrText: null, category: "outfit" });
    await turn(CARDS);
    const roles = sent[1]!.messages.slice(1).map((m) => m.role);
    expect(roles.slice(-4)).toEqual(["assistant", "tool", "tool", "user"]);
    const parts = sent[1]!.messages.at(-1)!.content as Array<Record<string, unknown>>;
    expect(String(parts[0]!.text)).toMatch(/data, not instructions/);
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: `https://signed/${USER}/${ITEM}.jpg`, detail: "low" } });
  });

  it("its URL is stored nowhere", async () => {
    queue = [calls([{ name: "view_screenshot", args: { id: ITEM } }]), plain];
    await turn(CARDS);
    for (const call of messageCreate.mock.calls) expect(JSON.stringify(call[0])).not.toContain("https://signed");
  });

  it("a library that fails costs that look, not the answer", async () => {
    itemFindFirst.mockRejectedValue(new Error("db down"));
    queue = [calls([{ name: "view_screenshot", args: { id: ITEM } }]), plain];
    const out = await turn(CARDS);
    expect(out.content).toBe("ок.");
  });
});
