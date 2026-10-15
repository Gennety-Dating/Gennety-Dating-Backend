import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wishlist card inside a chat turn (decision journal 2026-10-15): which
 * turns get the tool, where the card is stored, what the app gets back and
 * what the next turn's model reads. The card itself is tested in
 * `chat-wishlist.test.ts`.
 */

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";
const PHOTO = `${USER}/1700000000001.jpg`;

const findUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({
  telegramId: 4242n,
  language: "ru",
  profile: { homeCityKey: "ua:kyiv" },
}));
const messageCreate = vi.fn(async (a: { data: { content: string } }) => ({
  id: "m1",
  content: a.data.content,
  createdAt: new Date("2026-10-15T10:00:00Z"),
}));
let historyRows: unknown[] = [];
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a) },
    message: {
      create: (a: { data: { content: string } }) => messageCreate(a),
      findMany: async () => historyRows,
      delete: async () => undefined,
    },
  },
}));

vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [{ type: "function", function: { name: "update_hobbies", parameters: {} } }],
  TOOL_KINDS: { update_hobbies: "write" },
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: (r: string) => JSON.parse(r).success === true,
  executeAgentTool: async () => ({ result: JSON.stringify({ success: true }), receiptKey: null, action: null }),
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
vi.mock("./chat-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-consent.js")>()),
  personConsented: async () => true,
}));

type WishlistCard = import("./chat-wishlist.js").WishlistCard;
const card: WishlistCard = {
  kind: "wishlist_proposal",
  state: "open",
  items: [
    { key: "i1", title: "Lost Cherry", brand: "Tom Ford", category: "perfume", note: null, photoPath: PHOTO, remoteImageUrl: null, productUrl: null, priceBand: null, source: "text" },
  ],
  savedKeys: [],
  resolvedAt: null,
};
const proposeWishlistItems = vi.fn(async (_raw: unknown, _ctx: unknown) => ({
  result: JSON.stringify({ success: true, card: "shown" }),
  card: card as WishlistCard | null,
  openWishlist: false,
}));
vi.mock("./chat-wishlist.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chat-wishlist.js")>();
  return {
    ...original,
    proposeWishlistItems: (raw: unknown, ctx: unknown) => proposeWishlistItems(raw, ctx),
    wishlistCardViews: async (cards: WishlistCard[]) =>
      cards.map((c) => ({ kind: c.kind, state: c.state, items: [], savedCount: 0 })),
  };
});

type Sent = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
let queue: unknown[] = [];
const sent: Sent[] = [];
const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)) as Sent);
  const next = queue.shift();
  return next === "fail"
    ? { ok: false, status: 500, text: async () => "boom", json: async () => ({}) }
    : { ok: true, json: async () => next ?? plain };
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
const plain = { choices: [{ message: { role: "assistant", content: "огонь подборка. добавить в вишлист?" }, finish_reason: "stop" }] };
const propose = { name: "propose_wishlist_items", args: JSON.stringify({ items: [{ title: "Lost Cherry", category: "perfume", photo: PHOTO, image: "photo" }] }) };

const { runChatTurn } = await import("./chat-agent.js");
const WISHLIST = new Set(["wishlist"]);

beforeEach(() => {
  env.WISHLIST_FEATURE_ENABLED = true;
  queue = [];
  sent.length = 0;
  historyRows = [];
  messageCreate.mockClear();
  proposeWishlistItems.mockClear();
});

function toolNames(): string[] {
  return sent[0]!.tools.map((tool) => tool.function.name);
}

describe("which turns get the wishlist tool", () => {
  it("a build that draws the card, with the feature on", async () => {
    await runChatTurn({ userId: USER, text: "привет", imageUrls: [], chatCards: WISHLIST }, { fetchFn });
    expect(toolNames()).toContain("propose_wishlist_items");
    expect(String(sent[0]!.messages[0]!.content)).toContain("Their Date Wishlist");
  });

  it("not an older build that sends no header", async () => {
    await runChatTurn({ userId: USER, text: "привет", imageUrls: [] }, { fetchFn });
    expect(toolNames()).not.toContain("propose_wishlist_items");
    expect(String(sent[0]!.messages[0]!.content)).not.toContain("Their Date Wishlist");
  });

  it("not while the feature is off", async () => {
    env.WISHLIST_FEATURE_ENABLED = false;
    await runChatTurn({ userId: USER, text: "привет", imageUrls: [], chatCards: WISHLIST }, { fetchFn });
    expect(toolNames()).not.toContain("propose_wishlist_items");
  });
});

describe("a turn with a card", () => {
  it("stores the card on the reply and hands it to the app", async () => {
    queue = [calls([propose]), plain];
    const turn = await runChatTurn({ userId: USER, text: "вот мои любимые духи", imageUrls: [PHOTO], chatCards: WISHLIST }, { fetchFn });

    expect(proposeWishlistItems).toHaveBeenCalledWith(
      expect.objectContaining({ items: expect.any(Array) }),
      expect.objectContaining({ userId: USER, language: "ru", cityKey: "ua:kyiv", visiblePhotos: new Set([PHOTO]) }),
    );
    const reply = messageCreate.mock.calls.at(-1)![0] as unknown as { data: { role: string; attachment?: unknown } };
    expect(reply.data).toMatchObject({ role: "assistant", attachment: card });
    expect(turn.attachment).toMatchObject({ kind: "wishlist_proposal", state: "open" });
    expect(turn.content).toBe("огонь подборка. добавить в вишлист?");
    // Not a write: no receipt, no budget spent.
    expect(turn.receipts).toBeUndefined();
  });

  it("one card per reply", async () => {
    queue = [calls([propose, propose]), plain];
    await runChatTurn({ userId: USER, text: "духи", imageUrls: [PHOTO], chatCards: WISHLIST }, { fetchFn });
    expect(proposeWishlistItems).toHaveBeenCalledTimes(1);
    const second = sent.at(-1)!.messages.find((m) => m.role === "tool" && m.tool_call_id === "c1");
    expect(JSON.parse(String(second!.content))).toMatchObject({ error: "one_card_per_reply" });
  });

  it("a card without words still gets one line above it", async () => {
    queue = [calls([propose]), "fail", "fail"];
    const turn = await runChatTurn({ userId: USER, text: "духи", imageUrls: [PHOTO], chatCards: WISHLIST }, { fetchFn });
    expect(turn.content).toBe("Добавить в твой вишлист?");
    expect(turn.attachment).toBeDefined();
  });

  it("a full list gets the «Мой вишлист» button instead", async () => {
    proposeWishlistItems.mockResolvedValueOnce({ result: JSON.stringify({ success: false, error: "wishlist_full" }), card: null, openWishlist: true });
    queue = [calls([propose]), plain];
    const turn = await runChatTurn({ userId: USER, text: "духи", imageUrls: [PHOTO], chatCards: WISHLIST }, { fetchFn });
    expect(turn.attachment).toBeUndefined();
    expect(turn.action).toEqual({ kind: "entry_point", entry: { label: "Мой вишлист", callbackData: "menu:wishlist" } });
  });

  it("a model calling the tool on a build without the card is refused", async () => {
    queue = [calls([propose]), plain];
    const turn = await runChatTurn({ userId: USER, text: "духи", imageUrls: [PHOTO] }, { fetchFn });
    expect(proposeWishlistItems).not.toHaveBeenCalled();
    expect(turn.attachment).toBeUndefined();
  });
});

describe("an unanswered card", () => {
  it("is handed to the next card's builder, so the same items are not proposed twice", async () => {
    historyRows = [
      { role: "user", content: "да, добавь", imageUrl: null, imageUrls: [], context: null },
      { role: "assistant", content: "добавить в вишлист?", imageUrl: null, imageUrls: [], context: null, attachment: card },
    ];
    queue = [calls([propose]), plain];
    await runChatTurn({ userId: USER, text: "да, добавь", imageUrls: [], chatCards: WISHLIST }, { fetchFn });
    const ctx = proposeWishlistItems.mock.calls[0]![1] as { openCardItems: Set<string>; buttonLabel: string };
    expect([...ctx.openCardItems]).toEqual(["tom ford lost cherry"]);
    expect(ctx.buttonLabel).toBe("Добавить");
  });
});

describe("the next turn", () => {
  it("reads what happened to the card under the earlier reply", async () => {
    historyRows = [
      { role: "user", content: "спасибо", imageUrl: null, imageUrls: [], context: null },
      { role: "assistant", content: "добавить в вишлист?", imageUrl: null, imageUrls: [], context: null, attachment: { ...card, state: "saved", savedKeys: ["i1"] } },
      { role: "user", content: "вот духи", imageUrl: PHOTO, imageUrls: [PHOTO], context: null },
    ];
    await runChatTurn({ userId: USER, text: "спасибо", imageUrls: [], chatCards: WISHLIST }, { fetchFn });
    const assistant = sent[0]!.messages.find((m) => m.role === "assistant");
    expect(String(assistant!.content)).toContain("saved to their wishlist: «Tom Ford Lost Cherry»");
  });
});
