import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { COORDINATION_FEATURE_ENABLED: true },
}));
vi.mock("../config.js", () => ({ env: mockEnv }));

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn(), update: vi.fn() },
    proxyMessage: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

const { mockSendPush, mockSendMessage, mockSetReaction, mockGetApi } = vi.hoisted(() => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const setMessageReaction = vi.fn().mockResolvedValue(undefined);
  return {
    mockSendPush: vi.fn().mockResolvedValue(true),
    mockSendMessage: sendMessage,
    mockSetReaction: setMessageReaction,
    mockGetApi: vi.fn(() => ({ sendMessage, setMessageReaction })),
  };
});
vi.mock("./push.js", () => ({ sendPushToUser: mockSendPush }));
vi.mock("./main-bot-api.js", () => ({ getMainBotApi: mockGetApi }));
vi.mock("./outbound-recorder.js", () => ({
  withRedactedSummary: async (_s: string, fn: () => Promise<void>) => fn(),
}));

import { prisma } from "@gennety/db";
import {
  readProxyChat,
  relayProxyMessage,
  reactToProxyMessage,
  proxyChatWindow,
  proxyChatIsOpen,
  PROXY_REACTIONS,
} from "./proxy-chat.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn };
const mMsg = prisma.proxyMessage as unknown as {
  create: MockFn;
  findMany: MockFn;
  findFirst: MockFn;
  update: MockFn;
};

const DATE = new Date("2026-08-10T18:00:00.000Z");
const OPENS = new Date("2026-08-10T17:00:00.000Z");
const CLOSES = new Date("2026-08-10T20:00:00.000Z");

function match(over: Record<string, unknown> = {}): any {
  return {
    id: "m-1",
    status: "scheduled",
    userAId: "uid-A",
    userBId: "uid-B",
    agreedTime: DATE,
    coordMethod: "proxy",
    proxyClosedAt: null,
    proxyReadAtA: null,
    proxyReadAtB: null,
    userA: {
      id: "uid-A",
      telegramId: 1001n,
      platform: "telegram",
      language: "en",
      firstName: "Alice",
    },
    userB: {
      id: "uid-B",
      telegramId: -5000n,
      platform: "mobile",
      language: "en",
      firstName: "Bob",
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.COORDINATION_FEATURE_ENABLED = true;
  mMatch.findUnique.mockResolvedValue(match());
  mMsg.findMany.mockResolvedValue([]);
  mMsg.findFirst.mockResolvedValue(null);
  mMsg.create.mockResolvedValue({ id: "pm-1" });
  mMsg.update.mockResolvedValue({});
  mMatch.update.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

describe("proxyChatWindow", () => {
  it("is T-1h … T+2h around the agreed time", () => {
    const w = proxyChatWindow({ agreedTime: DATE, coordMethod: "proxy" });
    expect(w?.opensAt).toEqual(OPENS);
    expect(w?.closesAt).toEqual(CLOSES);
  });

  it("does not exist for a pair that chose to exchange contacts instead", () => {
    expect(proxyChatWindow({ agreedTime: DATE, coordMethod: "share_self" })).toBeNull();
    expect(proxyChatWindow({ agreedTime: DATE, coordMethod: null })).toBeNull();
  });

  /**
   * The window is derived from `agreedTime`, NOT read from `proxyOpenedAt` —
   * that column is written by a 2-minute cron tick, and gating on it opens the
   * window up to two minutes late. Both surfaces read this function,
   * so they cannot disagree about the edges.
   */
  it("is open on time even though no cron has stamped anything", () => {
    const m = { agreedTime: DATE, coordMethod: "proxy", proxyClosedAt: null };
    expect(proxyChatIsOpen(m, new Date(OPENS.getTime() - 1))).toBe(false);
    expect(proxyChatIsOpen(m, OPENS)).toBe(true);
    expect(proxyChatIsOpen(m, new Date(CLOSES.getTime() - 1))).toBe(true);
    expect(proxyChatIsOpen(m, CLOSES)).toBe(false);
  });

  it("an explicit close still wins inside the window", () => {
    const m = { agreedTime: DATE, coordMethod: "proxy", proxyClosedAt: new Date() };
    expect(proxyChatIsOpen(m, DATE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("readProxyChat", () => {
  /**
   * The client has to render "the chat opens at 19:30" before it opens and
   * "the chat has closed" after. A refusal there leaves it with nothing to
   * say, so only SENDING is gated on the window.
   */
  it("succeeds before the window opens and reports it shut", async () => {
    const res = await readProxyChat({
      matchId: "m-1",
      userId: "uid-A",
      now: new Date(OPENS.getTime() - 60_000),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.open).toBe(false);
    expect(res.view.opensAt).toEqual(OPENS);
    expect(res.view.closesAt).toEqual(CLOSES);
  });

  it("refuses a stranger with forbidden, not not-found", async () => {
    const res = await readProxyChat({ matchId: "m-1", userId: "uid-X", now: DATE });
    expect(res).toEqual({ ok: false, error: "forbidden" });
  });

  it("is wrong-state on a match that is not a scheduled date", async () => {
    mMatch.findUnique.mockResolvedValue(match({ status: "cancelled" }));
    const res = await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(res).toEqual({ ok: false, error: "wrong-state" });
  });

  it("does not exist while the feature is off", async () => {
    mockEnv.COORDINATION_FEATURE_ENABLED = false;
    const res = await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(res).toEqual({ ok: false, error: "disabled" });
  });

  /**
   * The sender is told about their OWN reply and nothing else. A status on the
   * partner's message would be telling them about themselves — so the key is
   * absent there, not null: `null` would invite a client to draw a fourth,
   * empty state.
   */
  it("says who sent each message, and carries a status on the caller's own only", async () => {
    mMsg.findMany.mockResolvedValue([
      { id: "pm-2", senderId: "uid-B", body: "at the door", createdAt: new Date(2), deliveredAt: null },
      { id: "pm-1", senderId: "uid-A", body: "on my way", createdAt: new Date(1), deliveredAt: null },
    ]);
    const res = await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Fetched newest-first so the cap keeps the recent end; rendered oldest-first.
    expect(res.view.messages.map((m) => m.id)).toEqual(["pm-1", "pm-2"]);
    expect(res.view.messages.map((m) => m.mine)).toEqual([true, false]);
    expect(Object.keys(res.view.messages[0]!).sort()).toEqual([
      "body",
      "id",
      "mine",
      "sentAt",
      "status",
    ]);
    expect(Object.keys(res.view.messages[1]!).sort()).toEqual(["body", "id", "mine", "sentAt"]);
  });

  /**
   * The three states come from three facts the server holds, and from nothing
   * else: a row, a rail that accepted it, a cursor a person moved. Timing and
   * the shape of the conversation are never consulted.
   */
  it("derives the three states from the row, the rail and the partner's cursor", async () => {
    mMatch.findUnique.mockResolvedValue(match({ proxyReadAtB: new Date(10) }));
    mMsg.findMany.mockResolvedValue([
      // Read: the partner's cursor is past it.
      { id: "pm-1", senderId: "uid-A", body: "one", createdAt: new Date(5), deliveredAt: new Date(5) },
      // Delivered: a rail took it, but the cursor has not reached it.
      { id: "pm-2", senderId: "uid-A", body: "two", createdAt: new Date(20), deliveredAt: new Date(20) },
      // Sent: logged, and no rail has accepted it.
      { id: "pm-3", senderId: "uid-A", body: "three", createdAt: new Date(30), deliveredAt: null },
    ]);
    const res = await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // `findMany` is newest-first in production; the view reverses it.
    expect(res.view.messages.map((m) => m.status)).toEqual(["sent", "delivered", "read"]);
  });

  /**
   * "Read" is a claim about another person, so it may only be made when that
   * person actually looked. Reading is the ONLY thing that moves the cursor.
   */
  it("advances the caller's read cursor when the partner has said something new", async () => {
    mMsg.findFirst.mockResolvedValue({ id: "pm-9" });
    await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: { proxyReadAtA: DATE },
    });
  });

  /**
   * The app polls this every four seconds for up to three hours. A cursor that
   * rewrote itself on every poll would be ~2700 pointless UPDATEs per open
   * chat, on the table the moderation trail depends on.
   */
  it("does not touch the cursor when there is nothing new from the partner", async () => {
    mMsg.findFirst.mockResolvedValue(null);
    await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(mMatch.update).not.toHaveBeenCalled();
  });

  /**
   * A cursor this match does not carry must not strand the client: it would
   * hold an id it can never advance past and would see nothing again, ever.
   */
  it("returns the whole window for an unknown cursor rather than failing", async () => {
    mMsg.findFirst.mockResolvedValue(null);
    await readProxyChat({ matchId: "m-1", userId: "uid-A", since: "nope", now: DATE });
    expect(mMsg.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { matchId: "m-1" } }),
    );
  });

  it("returns only newer messages for a known cursor", async () => {
    mMsg.findFirst.mockResolvedValue({ createdAt: new Date(5) });
    await readProxyChat({ matchId: "m-1", userId: "uid-A", since: "pm-1", now: DATE });
    expect(mMsg.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchId: "m-1", createdAt: { gt: new Date(5) } },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Relaying
// ---------------------------------------------------------------------------

describe("relayProxyMessage", () => {
  it("refuses a closed window without writing anything", async () => {
    const res = await relayProxyMessage({
      matchId: "m-1",
      senderUserId: "uid-A",
      body: "hi",
      now: new Date(CLOSES.getTime() + 1),
    });
    expect(res).toEqual({ ok: false, error: "closed" });
    expect(mMsg.create).not.toHaveBeenCalled();
  });

  it("refuses whitespace as empty", async () => {
    const res = await relayProxyMessage({
      matchId: "m-1",
      senderUserId: "uid-A",
      body: "   \n ",
      now: DATE,
    });
    expect(res).toEqual({ ok: false, error: "empty" });
    expect(mMsg.create).not.toHaveBeenCalled();
  });

  it("refuses an over-long message rather than truncating it", async () => {
    const res = await relayProxyMessage({
      matchId: "m-1",
      senderUserId: "uid-A",
      body: "x".repeat(1001),
      now: DATE,
    });
    expect(res).toEqual({ ok: false, error: "too-long" });
    expect(mMsg.create).not.toHaveBeenCalled();
  });

  /**
   * The moderation log is what justifies this carve-out to NO IN-APP CHAT
   * existing at all, so the write happens BEFORE delivery: a failed send must
   * never be able to produce an unlogged relayed message.
   */
  it("logs the message before delivering it", async () => {
    const order: string[] = [];
    mMsg.create.mockImplementation(async () => {
      order.push("log");
      return { id: "pm-1" };
    });
    mockSendPush.mockImplementation(async () => {
      order.push("deliver");
      return true;
    });
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-A", body: "hi", now: DATE });
    expect(order).toEqual(["log", "deliver"]);
    expect(mMsg.create).toHaveBeenCalledWith({
      data: { matchId: "m-1", senderId: "uid-A", body: "hi" },
      select: { id: true },
    });
  });

  /**
   * The second tick is a fact, not an optimism: it appears only once a rail has
   * ACCEPTED the message.
   */
  it("stamps delivery once a rail accepted the message", async () => {
    mockSendPush.mockResolvedValue(true);
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-A", body: "hi", now: DATE });
    expect(mMsg.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { deliveredAt: DATE },
    });
  });

  /**
   * An unreachable partner leaves one tick — which is the truth. It repairs
   * itself the moment they open the chat: reading moves their cursor, and
   * "read" outranks "delivered" without ever needing this stamp.
   */
  it("leaves delivery unstamped when no rail took the message", async () => {
    // The default partner is mobile-only (negative Telegram id), so the DM
    // branch is skipped and the push is the only rail there is.
    mockSendPush.mockResolvedValue(false);
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-A", body: "hi", now: DATE });
    expect(mMsg.update).not.toHaveBeenCalled();
  });

  /**
   * A `both` partner whose DM fails but whose push lands HAS been reached.
   * `Promise.all` would have reported the first rejection and called that a
   * failed delivery.
   */
  it("counts delivery when one rail of two succeeds", async () => {
    mMatch.findUnique.mockResolvedValue(
      match({ userB: { id: "uid-B", telegramId: 2002n, platform: "both", language: "en", firstName: "Bob" } }),
    );
    mockSendMessage.mockRejectedValueOnce(new Error("blocked by user"));
    mockSendPush.mockResolvedValue(true);
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-A", body: "hi", now: DATE });
    expect(mMsg.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { deliveredAt: DATE },
    });
  });

  /**
   * The relay used to DM and nothing else, so a mobile partner learned of a
   * message by opening the app — on the one screen whose whole value is the
   * hour before a meeting.
   */
  it("pushes a mobile partner and does not DM them", async () => {
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-A", body: "hi", now: DATE });
    expect(mockSendPush).toHaveBeenCalledWith(
      "uid-B",
      expect.objectContaining({ body: "hi", data: { type: "proxy.message", matchId: "m-1" } }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("DMs a Telegram partner and does not push them", async () => {
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-B", body: "hi", now: DATE });
    expect(mockSendMessage).toHaveBeenCalledWith(1001, expect.stringContaining("hi"), expect.any(Object));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("reaches a both-platform partner on both rails", async () => {
    mMatch.findUnique.mockResolvedValue(
      match({
        userB: {
          id: "uid-B",
          telegramId: 2002n,
          platform: "both",
          language: "en",
          firstName: "Bob",
        },
      }),
    );
    await relayProxyMessage({ matchId: "m-1", senderUserId: "uid-A", body: "hi", now: DATE });
    expect(mockSendMessage).toHaveBeenCalled();
    expect(mockSendPush).toHaveBeenCalled();
  });

  /**
   * Best-effort by rule: the message is logged and on the partner's screen the
   * next time they open the chat, which is the one delivery path that cannot
   * break. Failing the sender's send would be the wrong trade.
   */
  it("still succeeds when delivery throws", async () => {
    mockSendPush.mockRejectedValue(new Error("apns down"));
    const res = await relayProxyMessage({
      matchId: "m-1",
      senderUserId: "uid-A",
      body: "hi",
      now: DATE,
    });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * `uid-A` is the Telegram side, `uid-B` the app side (see `match()`). So a
 * message authored by A and reacted to by B is the case that has to reach
 * Telegram, and the reverse is the case that must not try.
 */
describe("reactToProxyMessage", () => {
  const fromA = {
    id: "pm-1",
    senderId: "uid-A",
    authorChatMessageId: 777n,
  };

  beforeEach(() => {
    mMsg.findFirst.mockResolvedValue(fromA);
  });

  it("writes the emoji and puts it on the author's OWN Telegram copy", async () => {
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-1",
      userId: "uid-B",
      reaction: "❤",
      now: DATE,
    });

    expect(res.ok).toBe(true);
    expect(mMsg.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { reaction: "❤" },
    });
    // Chat id is the AUTHOR's, message id is their own copy — not the relayed
    // one, which lives in the reader's chat and is a different message.
    expect(mockSetReaction).toHaveBeenCalledWith(
      1001,
      777,
      [{ type: "emoji", emoji: "❤" }],
      { is_big: false },
    );
  });

  /**
   * The regression this guards is invisible on screen and fatal on the wire:
   * Telegram's list holds U+2764 alone, and the pretty red heart
   * (U+2764 U+FE0F) is a DIFFERENT string that `setMessageReaction` refuses.
   */
  it("keeps the heart free of the variation selector", () => {
    expect([...PROXY_REACTIONS[0]].map((c) => c.codePointAt(0))).toEqual([0x2764]);
    expect(PROXY_REACTIONS).toHaveLength(5);
    expect(PROXY_REACTIONS as readonly string[]).not.toContain("\u{1F602}");
  });

  it("clears with null, which Telegram spells as an empty list", async () => {
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-1",
      userId: "uid-B",
      reaction: null,
      now: DATE,
    });

    expect(res.ok).toBe(true);
    expect(mMsg.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { reaction: null },
    });
    expect(mockSetReaction).toHaveBeenCalledWith(1001, 777, [], { is_big: false });
  });

  it("refuses an emoji outside the closed set", async () => {
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-1",
      userId: "uid-B",
      reaction: "\u{1F355}",
      now: DATE,
    });

    expect(res).toEqual({ ok: false, error: "bad-reaction" });
    expect(mMsg.update).not.toHaveBeenCalled();
  });

  /**
   * The app hides the gesture on one's own bubble, but a hidden gesture is not
   * a rule — this is where the rule lives.
   */
  it("refuses a reaction on one's own message", async () => {
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-1",
      userId: "uid-A",
      reaction: "\u{1F44D}",
      now: DATE,
    });

    expect(res).toEqual({ ok: false, error: "own-message" });
    expect(mMsg.update).not.toHaveBeenCalled();
  });

  it("refuses a message that is not in this match", async () => {
    mMsg.findFirst.mockResolvedValue(null);
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-nope",
      userId: "uid-B",
      reaction: "\u{1F44D}",
      now: DATE,
    });

    expect(res).toEqual({ ok: false, error: "no-message" });
  });

  it("refuses a caller who is not on the match", async () => {
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-1",
      userId: "uid-stranger",
      reaction: "\u{1F44D}",
      now: DATE,
    });

    expect(res).toEqual({ ok: false, error: "forbidden" });
  });

  /**
   * An app-authored line has no Telegram copy of its own, so there is nothing
   * to react to on that rail — but the row is still written, and its author
   * reads it off the next poll.
   */
  it("writes without touching Telegram when the author wrote from the app", async () => {
    mMsg.findFirst.mockResolvedValue({
      id: "pm-2",
      senderId: "uid-B",
      authorChatMessageId: null,
    });

    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-2",
      userId: "uid-A",
      reaction: "\u{1F64F}",
      now: DATE,
    });

    expect(res.ok).toBe(true);
    expect(mMsg.update).toHaveBeenCalledWith({
      where: { id: "pm-2" },
      data: { reaction: "\u{1F64F}" },
    });
    expect(mockSetReaction).not.toHaveBeenCalled();
  });

  /**
   * Rows written before `authorChatMessageId` existed carry null. They are
   * app-visible only, and the whole migration story decays within one window.
   */
  it("survives a legacy row with no author message id", async () => {
    mMsg.findFirst.mockResolvedValue({
      id: "pm-old",
      senderId: "uid-A",
      authorChatMessageId: null,
    });

    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-old",
      userId: "uid-B",
      reaction: "\u{1F525}",
      now: DATE,
    });

    expect(res.ok).toBe(true);
    expect(mockSetReaction).not.toHaveBeenCalled();
  });

  /**
   * Sending is time-boxed; answering a line already said is not. Refusing here
   * would leave the last "I'm outside" unanswerable at the exact moment the
   * pair is meeting.
   */
  it("still works after the window has closed", async () => {
    const afterClose = new Date(CLOSES.getTime() + 60 * 60 * 1000);
    const res = await reactToProxyMessage({
      matchId: "m-1",
      messageId: "pm-1",
      userId: "uid-B",
      reaction: "\u{1F44D}",
      now: afterClose,
    });

    expect(res.ok).toBe(true);
  });

  it("shows the reaction to BOTH sides, unlike the delivery status", async () => {
    mMsg.findMany.mockResolvedValue([
      {
        id: "pm-1",
        senderId: "uid-A",
        body: "on my way",
        createdAt: DATE,
        deliveredAt: DATE,
        reaction: "❤",
      },
    ]);

    const asReader = await readProxyChat({ matchId: "m-1", userId: "uid-B", now: DATE });
    const asAuthor = await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });

    expect(asReader.ok && asReader.view.messages[0]!.reaction).toBe("❤");
    expect(asAuthor.ok && asAuthor.view.messages[0]!.reaction).toBe("❤");
    // The author sees a status on their own line; the reader does not.
    expect(asAuthor.ok && asAuthor.view.messages[0]!.status).toBeDefined();
    expect(asReader.ok && asReader.view.messages[0]!.status).toBeUndefined();
  });

  it("omits the key entirely when nobody has reacted", async () => {
    mMsg.findMany.mockResolvedValue([
      {
        id: "pm-1",
        senderId: "uid-A",
        body: "on my way",
        createdAt: DATE,
        deliveredAt: DATE,
        reaction: null,
      },
    ]);

    const res = await readProxyChat({ matchId: "m-1", userId: "uid-B", now: DATE });
    expect(res.ok && "reaction" in res.view.messages[0]!).toBe(false);
  });
});
