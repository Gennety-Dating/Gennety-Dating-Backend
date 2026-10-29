import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The change-offer card inside a chat turn (decision journal 2026-10-28):
 * which turns get `offer_change` and the card prompt, where the offer is
 * stored, what the app gets back, what the next turn's model reads, and a
 * typed «да» answering an open card. The card itself is tested in
 * `chat-offer.test.ts`.
 */

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";

const messageCreate = vi.fn(async (a: { data: { content: string } }) => ({
  id: "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-10-28T10:00:00Z"),
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
  receiptKey: "editHobbiesSaved" as const,
  action: null,
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [{ type: "function", function: { name: "update_hobbies", parameters: {} } }],
  TOOL_KINDS: { update_hobbies: "write" },
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
const consent = vi.fn(async (_q: { previous: string; message: string; tool: string }) => true);

const expireOlderOffers = vi.fn(async (_userId: string, _keepId: string) => undefined);
const markOfferAccepted = vi.fn(async (_userId: string, _id: string, _receipt: string | null) => undefined);
vi.mock("./chat-offer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-offer.js")>()),
  expireOlderOffers: (userId: string, keepId: string) => expireOlderOffers(userId, keepId),
  markOfferAccepted: (userId: string, id: string, receipt: string | null) => markOfferAccepted(userId, id, receipt),
}));

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
const plain = { choices: [{ message: { role: "assistant", content: "парфюмерный гардероб — это уже характер." }, finish_reason: "stop" }] };
const offerCall = {
  name: "offer_change",
  args: JSON.stringify({ tool: "update_hobbies", args: { add: ["парфюмерия"] }, question: "Добавить «парфюмерия» в интересы?", acceptLabel: "Добавить" }),
};
const storedOffer = {
  kind: "change_offer",
  state: "open",
  question: "Добавить «парфюмерия» в интересы?",
  acceptLabel: "Добавить",
  tool: "update_hobbies",
  args: { add: ["парфюмерия"] },
};

const { runChatTurn, chatAddendum } = await import("./chat-agent.js");
const OFFER = new Set(["offer"]);

beforeEach(() => {
  env.WISHLIST_FEATURE_ENABLED = true;
  queue = [];
  sent.length = 0;
  historyRows = [];
  messageCreate.mockClear();
  executeAgentTool.mockClear();
  expireOlderOffers.mockClear();
  markOfferAccepted.mockClear();
  consent.mockClear();
});

const toolNames = () => sent[0]!.tools.map((tool) => tool.function.name);
const system = () => String(sent[0]!.messages[0]!.content);

describe("which turns get offer_change", () => {
  it("a build that sends `offer`: the tool, the card prompt, no prose offer", async () => {
    await runChatTurn({ userId: USER, text: "привет", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    expect(toolNames()).toContain("offer_change");
    expect(system()).toContain("Offers are buttons");
    expect(system()).not.toContain("Offer it as one short\n  question");
    // Wishlist coordination only when both cards are drawn.
    expect(system()).not.toContain("Things for their Date Wishlist are not a profile change");
  });

  it("an older build or Telegram-style turn without the header: unchanged prose offer", async () => {
    await runChatTurn({ userId: USER, text: "привет", imageUrls: [] }, { fetchFn, consent });
    expect(toolNames()).not.toContain("offer_change");
    expect(system()).not.toContain("Offers are buttons");
    expect(system()).toContain("Offer it as one short\n  question; change nothing until they say yes.");
  });

  it("the addendum without the card is the old text byte for byte; with it, only the offer sentence differs", () => {
    const old = chatAddendum(false);
    const withCard = chatAddendum(true);
    expect(old).toContain("tune who they're matched with). Offer it as one short\n  question; change nothing until they say yes. A personal share never gets");
    expect(withCard).not.toBe(old);
    expect(withCard).toContain("Offer it ONLY through `offer_change`");
  });

  it("both cards: the wishlist note says wishlist things stay on the wishlist card", async () => {
    await runChatTurn({ userId: USER, text: "привет", imageUrls: [], chatCards: new Set(["wishlist", "offer"]) }, { fetchFn, consent });
    expect(toolNames()).toEqual(expect.arrayContaining(["offer_change", "propose_wishlist_items"]));
    expect(system()).toContain("Things for their Date Wishlist are not a profile change");
  });
});

describe("a turn with an offer", () => {
  it("stores the offer on the reply, returns it as `offer` (not `attachment`), writes nothing, expires older ones", async () => {
    queue = [calls([offerCall]), plain];
    const turn = await runChatTurn({ userId: USER, text: "у меня парфюмерный гардероб", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });

    const reply = messageCreate.mock.calls.at(-1)![0] as unknown as { data: { role: string; attachment?: unknown } };
    expect(reply.data).toMatchObject({ role: "assistant", attachment: storedOffer });
    expect(turn.offer).toEqual({ state: "open", question: "Добавить «парфюмерия» в интересы?", acceptLabel: "Добавить", receipt: null });
    expect(turn.attachment).toBeUndefined();
    expect(turn.receipts).toBeUndefined();
    expect(executeAgentTool).not.toHaveBeenCalled();
    expect(expireOlderOffers).toHaveBeenCalledWith(USER, "reply-1");
  });

  it("one offer per turn", async () => {
    queue = [calls([offerCall, offerCall]), plain];
    await runChatTurn({ userId: USER, text: "духи", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    const second = sent.at(-1)!.messages.find((m) => m.role === "tool" && m.tool_call_id === "c1");
    expect(JSON.parse(String(second!.content))).toMatchObject({ error: "one_card_per_reply" });
  });

  it("invalid args go back to the model, no card", async () => {
    queue = [calls([{ name: "offer_change", args: JSON.stringify({ tool: "set_language", args: {}, question: "?" }) }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "духи", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    expect(turn.offer).toBeUndefined();
    const result = sent.at(-1)!.messages.find((m) => m.role === "tool");
    expect(JSON.parse(String(result!.content))).toMatchObject({ success: false, error: "invalid_args" });
  });

  it("a model calling it on a build without the card is refused", async () => {
    queue = [calls([offerCall]), plain];
    const turn = await runChatTurn({ userId: USER, text: "духи", imageUrls: [] }, { fetchFn, consent });
    expect(turn.offer).toBeUndefined();
    expect(expireOlderOffers).not.toHaveBeenCalled();
    const result = sent.at(-1)!.messages.find((m) => m.role === "tool");
    expect(JSON.parse(String(result!.content))).toMatchObject({ error: "unknown_tool" });
  });

  it("an offer without words still gets a line that does not repeat the question", async () => {
    queue = [calls([offerCall]), "fail", "fail"];
    const turn = await runChatTurn({ userId: USER, text: "духи", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    expect(turn.content).toBe("Есть идея:");
    expect(turn.offer?.state).toBe("open");
  });
});

describe("the next turn", () => {
  // `findMany` answers newest first, as the query asks.
  it("reads the offer's state under the earlier reply", async () => {
    historyRows = [
      { id: "u2", role: "user", content: "ок", imageUrl: null, imageUrls: [], context: null },
      { id: "a1", role: "assistant", content: "парфюмерия — это характер.", imageUrl: null, imageUrls: [], context: null, attachment: { ...storedOffer, state: "declined" } },
    ];
    await runChatTurn({ userId: USER, text: "ок", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    const assistant = sent[0]!.messages.find((m) => m.role === "assistant");
    expect(String(assistant!.content)).toContain("They tapped «Not now»");
  });

  it("a typed «да» under an open card: the consent check sees the question, and the card turns accepted", async () => {
    historyRows = [
      { id: "u2", role: "user", content: "да", imageUrl: null, imageUrls: [], context: null },
      { id: "a1", role: "assistant", content: "парфюмерия — это характер.", imageUrl: null, imageUrls: [], context: null, attachment: storedOffer },
    ];
    queue = [calls([{ name: "update_hobbies", args: JSON.stringify({ add: ["парфюмерия"] }) }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "да", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    expect(consent.mock.calls[0]![0].previous).toContain("Добавить «парфюмерия» в интересы?");
    expect(executeAgentTool).toHaveBeenCalledWith(4242n, "update_hobbies", { add: ["парфюмерия"] });
    expect(markOfferAccepted).toHaveBeenCalledWith(USER, "a1", "Интересы обновлены");
    expect(turn.receipts).toEqual(["Интересы обновлены"]);
  });

  it("a different change does not answer the card", async () => {
    historyRows = [
      { id: "u2", role: "user", content: "добавь джаз", imageUrl: null, imageUrls: [], context: null },
      { id: "a1", role: "assistant", content: "x", imageUrl: null, imageUrls: [], context: null, attachment: { ...storedOffer, tool: "update_major", args: { major: "CS" } } },
    ];
    queue = [calls([{ name: "update_hobbies", args: JSON.stringify({ add: ["джаз"] }) }]), plain];
    await runChatTurn({ userId: USER, text: "добавь джаз", imageUrls: [], chatCards: OFFER }, { fetchFn, consent });
    expect(markOfferAccepted).not.toHaveBeenCalled();
  });
});
