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
    match: { findUnique: vi.fn() },
    proxyMessage: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

const { mockSendPush, mockSendMessage, mockGetApi } = vi.hoisted(() => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    mockSendPush: vi.fn().mockResolvedValue(true),
    mockSendMessage: sendMessage,
    mockGetApi: vi.fn(() => ({ sendMessage })),
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
  proxyChatWindow,
  proxyChatIsOpen,
} from "./proxy-chat.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn };
const mMsg = prisma.proxyMessage as unknown as {
  create: MockFn;
  findMany: MockFn;
  findFirst: MockFn;
};

const DATE = new Date("2026-08-10T18:00:00.000Z");
const OPENS = new Date("2026-08-10T17:30:00.000Z");
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
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

describe("proxyChatWindow", () => {
  it("is T-30m … T+2h around the agreed time", () => {
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
   * that column is written by a 2-minute cron tick, and gating on it opens a
   * 30-minute window up to two minutes late. Both surfaces read this function,
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

  it("labels each message by whether the caller sent it, and nothing more", async () => {
    mMsg.findMany.mockResolvedValue([
      { id: "pm-2", senderId: "uid-B", body: "at the door", createdAt: new Date(2) },
      { id: "pm-1", senderId: "uid-A", body: "on my way", createdAt: new Date(1) },
    ]);
    const res = await readProxyChat({ matchId: "m-1", userId: "uid-A", now: DATE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Fetched newest-first so the cap keeps the recent end; rendered oldest-first.
    expect(res.view.messages.map((m) => m.id)).toEqual(["pm-1", "pm-2"]);
    expect(res.view.messages.map((m) => m.mine)).toEqual([true, false]);
    expect(Object.keys(res.view.messages[0]!).sort()).toEqual(["body", "id", "mine", "sentAt"]);
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
    });
  });

  /**
   * The relay used to DM and nothing else, so a mobile partner learned of a
   * message by opening the app — on the one screen whose whole value is the
   * half hour before a meeting.
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
