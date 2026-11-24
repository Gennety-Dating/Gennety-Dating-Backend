import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Emoji reactions in the app chat (decision 2026-11-24): the person's reaction
 * on Gennety's replies, the server guard over Gennety's own, and the line the
 * next turn's model reads. The turn loop is in `chat-agent-reactions.test.ts`.
 */

const env: Record<string, unknown> = { AGENT_REACTIONS_ENABLED: true, AGENT_REACTIONS_USER_IDS: [] };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
type Row = { id: string; userId: string; role: string; userReaction: string | null; agentReaction: string | null };
let row: Row | null = null;
const update = vi.fn(async (a: { data: { userReaction: string | null } }) => {
  row = { ...row!, userReaction: a.data.userReaction };
  return { userReaction: row.userReaction, agentReaction: row.agentReaction };
});
vi.mock("@gennety/db", () => ({
  prisma: {
    message: {
      findUnique: async () => row,
      update: (a: { data: { userReaction: string | null } }) => update(a),
    },
  },
}));

const {
  agentEmojiAllowed,
  agentReactionGate,
  chatReactionsDrawn,
  checkAgentReaction,
  isClosingTurn,
  personReactionsBlock,
  reactionExcerpt,
  setPersonReaction,
} = await import("./chat-reactions.js");
const { REACTION_EMOJI, normalizeReactionEmoji } = await import("@gennety/shared");

beforeEach(() => {
  row = { id: "a1", userId: USER, role: "assistant", userReaction: null, agentReaction: null };
  update.mockClear();
  env.AGENT_REACTIONS_ENABLED = true;
  env.AGENT_REACTIONS_USER_IDS = [];
});

describe("the set", () => {
  it("is the proxy chat's five, red ❤️ folded to Telegram's ❤", () => {
    expect([...REACTION_EMOJI]).toEqual(["❤", "👍", "🔥", "🤣", "🙏"]);
    expect(normalizeReactionEmoji("❤️")).toBe("❤");
    expect(normalizeReactionEmoji(" 🙏 ")).toBe("🙏");
    expect(normalizeReactionEmoji("👎")).toBeNull();
    expect(normalizeReactionEmoji("😂")).toBeNull();
  });
});

describe("gate: build + flag", () => {
  it("needs the `reactions` token and the flag (or the preview list)", () => {
    expect(chatReactionsDrawn(USER, new Set(["reactions"]))).toBe(true);
    expect(chatReactionsDrawn(USER, new Set(["vibe", "reminder"]))).toBe(false);
    expect(chatReactionsDrawn(USER, undefined)).toBe(false);
    env.AGENT_REACTIONS_ENABLED = false;
    expect(chatReactionsDrawn(USER, new Set(["reactions"]))).toBe(false);
    env.AGENT_REACTIONS_USER_IDS = [USER];
    expect(chatReactionsDrawn(USER, new Set(["reactions"]))).toBe(true);
    expect(chatReactionsDrawn(OTHER, new Set(["reactions"]))).toBe(false);
  });
});

describe("the person's reaction", () => {
  const set = (emoji: string | null, userId = USER) => setPersonReaction({ userId, messageId: "a1", emoji });

  it("sets, replaces, and takes off with the same emoji again or null", async () => {
    expect(await set("❤️")).toEqual({ ok: true, reactions: { user: "❤", agent: null } });
    expect(await set("🔥")).toEqual({ ok: true, reactions: { user: "🔥", agent: null } });
    expect(await set("🔥")).toEqual({ ok: true, reactions: { user: null, agent: null } });
    await set("👍");
    expect(await set(null)).toEqual({ ok: true, reactions: { user: null, agent: null } });
  });

  it("null on a row with nothing writes nothing", async () => {
    expect(await set(null)).toEqual({ ok: true, reactions: { user: null, agent: null } });
    expect(update).not.toHaveBeenCalled();
  });

  it("someone else's message or a missing one is not-found", async () => {
    expect(await set("❤", OTHER)).toEqual({ ok: false, error: "not-found" });
    row = null;
    expect(await set("❤")).toEqual({ ok: false, error: "not-found" });
    expect(update).not.toHaveBeenCalled();
  });

  it("only Gennety's replies take it", async () => {
    row = { ...row!, role: "user" };
    expect(await set("❤")).toEqual({ ok: false, error: "not-assistant" });
  });

  it("an emoji outside the set is refused before any read", async () => {
    expect(await set("👎")).toEqual({ ok: false, error: "bad-reaction" });
    expect(await set("like")).toEqual({ ok: false, error: "bad-reaction" });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("closing turns", () => {
  it.each(["ок, спасибо", "Понял", "спасибо!", "ok thanks", "дякую", "👍", "🙏🙏", "❤️", "ок 👍", "got it"])("«%s» closes", (text) => {
    expect(isClosingTurn(text)).toBe(true);
  });
  it.each(["ок, а что с баром?", "спасибо, а завтра можно?", "👍🔥", "мне грустно", "расскажи про бар", "", "🤣"])(
    "«%s» does not",
    (text) => {
      expect(isClosingTurn(text)).toBe(false);
    },
  );
});

describe("Gennety's reaction: the guard", () => {
  const facts = (over: Partial<Parameters<typeof agentReactionGate>[0]> = {}) => ({
    userText: "ок, спасибо",
    imageCount: 0,
    hasContext: false,
    recentUser: [{ content: "ок, спасибо", agentReaction: null }, { content: "где выпить кофе?", agentReaction: null }],
    previousAssistant: { content: "Попробуй «Зерно» на Подоле — тихо и вкусно.", openOffer: false },
    safetyLatched: false,
    ...over,
  });

  it("a closing after an answer: allowed, 🙏 👍 ❤ only", () => {
    expect(agentReactionGate(facts())).toEqual({ ok: true, occasion: "closing", emoji: ["🙏", "👍", "❤"] });
  });

  it("refuses a photo, a context chip, or a message that is not a closing", () => {
    expect(agentReactionGate(facts({ imageCount: 1 }))).toMatchObject({ ok: false, reason: "photo" });
    expect(agentReactionGate(facts({ hasContext: true }))).toMatchObject({ ok: false, reason: "context" });
    expect(agentReactionGate(facts({ userText: "а что там с вином?" }))).toMatchObject({ ok: false, reason: "not_closing" });
  });

  it("an «ок» to a question or an open offer is words: a reaction is not a yes", () => {
    expect(agentReactionGate(facts({ previousAssistant: { content: "Подобрать ещё пару мест?", openOffer: false } }))).toMatchObject({
      ok: false,
      reason: "question_open",
    });
    expect(agentReactionGate(facts({ previousAssistant: { content: "Добавить в интересы.", openOffer: true } }))).toMatchObject({
      ok: false,
      reason: "offer_open",
    });
  });

  it.each([
    "мне так грустно после вчерашнего",
    "она отменила свидание",
    "мне страшно, он пишет мне угрозы",
    "хочу пожаловаться на бота",
    "I feel so lonely",
    "my date cancelled",
    "jestem smutna",
  ])("never after «%s»", (earlier) => {
    const verdict = agentReactionGate(facts({ recentUser: [{ content: "ок, спасибо", agentReaction: null }, { content: earlier, agentReaction: null }] }));
    expect(verdict).toMatchObject({ ok: false, reason: "sensitive" });
  });

  it("never with the chat's safety latch set", () => {
    expect(agentReactionGate(facts({ safetyLatched: true }))).toMatchObject({ ok: false, reason: "safety" });
  });

  it("never two in a row", () => {
    const recentUser = [
      { content: "ок, спасибо", agentReaction: null },
      { content: "понял", agentReaction: "👍" },
    ];
    expect(agentReactionGate(facts({ recentUser }))).toMatchObject({ ok: false, reason: "in_a_row" });
  });

  it("at most one per five of their messages", () => {
    const msg = (agentReaction: string | null) => ({ content: "что-то", agentReaction });
    // Reacted four messages back: this one is the fifth of that window.
    const tooSoon = [msg(null), msg(null), msg(null), msg(null), msg("🙏")];
    expect(agentReactionGate(facts({ recentUser: tooSoon }))).toMatchObject({ ok: false, reason: "too_soon" });
    // Reacted five messages back: out of the window.
    const fine = [msg(null), msg(null), msg(null), msg(null), msg(null), msg("🙏")];
    expect(agentReactionGate(facts({ recentUser: fine }))).toMatchObject({ ok: true });
  });
});

describe("Gennety's reaction: the emoji", () => {
  it("🤣 never on a photo or on what they tell about themselves, whatever the occasion allows", () => {
    const all = ["❤", "👍", "🔥", "🤣", "🙏"] as const;
    expect(agentEmojiAllowed("🤣", { allowed: all, onPhoto: true, aboutThemselves: false })).toBe(false);
    expect(agentEmojiAllowed("🤣", { allowed: all, onPhoto: false, aboutThemselves: true })).toBe(false);
    expect(agentEmojiAllowed("🤣", { allowed: all, onPhoto: false, aboutThemselves: false })).toBe(true);
  });

  it("checks the call: allowed emoji pass, others and a second reaction are refused with «answer in words»", () => {
    const gate = { ok: true as const, occasion: "closing" as const, emoji: ["🙏", "👍", "❤"] as const };
    expect(checkAgentReaction(JSON.stringify({ emoji: "❤️" }), { gate, already: false, onPhoto: false })).toMatchObject({ ok: true, emoji: "❤" });
    const fire = checkAgentReaction(JSON.stringify({ emoji: "🔥" }), { gate, already: false, onPhoto: false });
    expect(fire.ok).toBe(false);
    expect(JSON.parse(fire.result)).toMatchObject({ success: false, error: "emoji_not_allowed", instruction: expect.stringContaining("in words") });
    expect(checkAgentReaction(JSON.stringify({ emoji: "🙏" }), { gate, already: true, onPhoto: false }).ok).toBe(false);
    expect(checkAgentReaction("{", { gate, already: false, onPhoto: false }).ok).toBe(false);
    expect(checkAgentReaction(JSON.stringify({ emoji: "🙏" }), { gate: { ok: false, reason: "photo" }, already: false, onPhoto: false }).ok).toBe(false);
  });
});

describe("the prompt line for the person's reaction", () => {
  const at = (iso: string) => new Date(iso);
  const rows = [
    { role: "user", content: "где послушать джаз?", createdAt: at("2026-11-24T10:00:00Z") },
    {
      role: "assistant",
      content: "Бар с джазом на Подоле, «Купидон»: живая музыка по четвергам с восьми вечера, лучше бронировать стол заранее.",
      createdAt: at("2026-11-24T10:00:01Z"),
      userReaction: "❤",
      reactedAt: at("2026-11-24T10:05:00Z"),
    },
    { role: "user", content: "а в субботу?", createdAt: at("2026-11-24T10:06:00Z") },
  ];

  it("names the reaction with a short piece of the reply, and says it is not a yes", () => {
    const block = personReactionsBlock(rows)!;
    expect(block).toContain("They reacted ❤ to your message «Бар с джазом на Подоле, «Купидон»: живая музыка по…»");
    expect(block).toContain("not a yes");
    expect(block).toContain("books, saves, accepts or confirms\nnothing");
  });

  it("a reaction already seen by an earlier turn is not named again", () => {
    const later = [...rows, { role: "assistant", content: "В субботу тоже.", createdAt: at("2026-11-24T10:06:01Z") }, { role: "user", content: "ок", createdAt: at("2026-11-24T10:10:00Z") }];
    expect(personReactionsBlock(later)).toBeNull();
  });

  it("no reactions — no block", () => {
    expect(personReactionsBlock(rows.map((r) => ({ ...r, userReaction: null })))).toBeNull();
  });

  it("cuts the excerpt at a word", () => {
    expect(reactionExcerpt("коротко")).toBe("коротко");
    expect([...reactionExcerpt("слово ".repeat(30))].length).toBeLessThanOrEqual(61);
  });
});
