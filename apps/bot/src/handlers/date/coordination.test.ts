import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION, t } from "@gennety/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    proxyMessage: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../../config.js", () => ({ env: { COORDINATION_FEATURE_ENABLED: true } }));

// The relay delivers through `services/proxy-chat.ts`, which reaches the
// partner on the process-wide bot handle and on APNs rather than on `ctx.api`.
// Both are stubbed so the assertions can watch the partner's rails directly.
const { mockPartnerSend, mockSendPush } = vi.hoisted(() => ({
  mockPartnerSend: vi.fn().mockResolvedValue(undefined),
  mockSendPush: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../services/main-bot-api.js", () => ({
  getMainBotApi: () => ({ sendMessage: mockPartnerSend }),
}));
vi.mock("../../services/push.js", () => ({ sendPushToUser: mockSendPush }));
vi.mock("../../services/outbound-recorder.js", () => ({
  withRedactedSummary: async (_s: string, fn: () => Promise<void>) => fn(),
}));

// The coordination DMs ride a rendered PNG (PRODUCT_SPEC §Phase 4). Stub the
// raster — a real satori render costs seconds per call and says nothing about
// the flow; `services/coordination-card/send.test.ts` covers the delivery
// branches, and the demo script covers the layout.
const { mockRenderCard } = vi.hoisted(() => ({
  mockRenderCard: vi.fn().mockResolvedValue(Buffer.from("png")),
}));
vi.mock("../../services/coordination-card/index.js", () => ({
  renderCoordinationCard: mockRenderCard,
}));

import { prisma } from "@gennety/db";
import {
  handleRetiredCoordCard,
  handleCoordEnter,
  handleCoordExit,
  handleProxyRelay,
} from "./coordination.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn; updateMany: MockFn };
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mProxy = prisma.proxyMessage as unknown as { create: MockFn; findMany: MockFn; update: MockFn };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(over: {
  session?: Partial<SessionData>;
  callbackData?: string;
  messageText?: string;
  message?: unknown;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    onboardingStep: "completed",
    language: "en",
    ...over.session,
  };
  return {
    session,
    from: { id: over.fromId ?? 1001, username: "caller" },
    callbackQuery: over.callbackData ? { data: over.callbackData } : undefined,
    message:
      over.message !== undefined
        ? over.message
        : over.messageText
          ? { message_id: 77, text: over.messageText }
          : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function coordUser(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uid-A",
    telegramId: 1001n,
    platform: "telegram",
    language: "en",
    theme: "dark",
    firstName: "Alice",
    gender: "female",
    telegramUsername: "alice",
    profile: { photos: ["file-alice-1"] },
    ...over,
  };
}

function coordMatch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    status: "scheduled",
    agreedTime: null,
    coordInitiatorId: null,
    coordMethod: null,
    coordPartnerConsent: null,
    proxyOpenedAt: null,
    proxyClosesAt: null,
    proxyClosedAt: null,
    userAId: "uid-A",
    userBId: "uid-B",
    userA: coordUser({ id: "uid-A", gender: "female", telegramId: 1001n, telegramUsername: "alice" }),
    userB: coordUser({
      id: "uid-B",
      gender: "male",
      telegramId: 1002n,
      firstName: "Bob",
      telegramUsername: "bob",
    }),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mMatch.update.mockResolvedValue({});
  mMatch.updateMany.mockResolvedValue({ count: 1 });
  mProxy.create.mockResolvedValue({ id: "pm-1" });
  mProxy.findMany.mockResolvedValue([]);
  mProxy.update.mockResolvedValue({});
  mockPartnerSend.mockResolvedValue(undefined);
  mockSendPush.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Retired questionnaire buttons (founder decision 2026-09-26)
// ---------------------------------------------------------------------------

describe("handleRetiredCoordCard", () => {
  /**
   * Offer, ask and consent cards sent before the questionnaire was retired are
   * still in people's chats. A tap on one writes nothing, reveals no handle and
   * DMs nobody — it only stops the spinner and takes the dead keyboard off.
   */
  it.each([
    "coord:m:m1:share_self",
    "coord:m:m1:request_partner",
    "coord:m:m1:proxy",
    "coord:approve:m1",
    "coord:decline:m1",
  ])("answers %s and strips the keyboard, doing nothing else", async (callbackData) => {
    const ctx = createCtx({ callbackData, fromId: 1001 });
    await handleRetiredCoordCard(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    expect(mMatch.findUnique).not.toHaveBeenCalled();
    expect(mMatch.update).not.toHaveBeenCalled();
    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.api.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("ignores callbacks that are not the questionnaire's", async () => {
    const ctx = createCtx({ callbackData: "coord:enter:m1", fromId: 1001 });
    await handleRetiredCoordCard(ctx);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Proxy enter / exit / relay
// ---------------------------------------------------------------------------

const openWindow = {
  proxyOpenedAt: new Date("2026-06-04T12:00:00Z"),
  proxyClosesAt: new Date("2030-01-01T00:00:00Z"),
};

describe("handleCoordEnter", () => {
  it("sets coordination_chat state only inside the open window", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch(openWindow));

    const ctx = createCtx({ callbackData: "coord:enter:m1", fromId: 1001 });
    await handleCoordEnter(ctx);

    expect(ctx.session.matchFlow).toBe("coordination_chat");
    expect(ctx.session.activeMatchId).toBe("m1");
  });

  it("refuses entry to a closed window", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({ proxyOpenedAt: new Date(), proxyClosedAt: new Date() }),
    );

    const ctx = createCtx({ callbackData: "coord:enter:m1", fromId: 1001 });
    await handleCoordEnter(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordProxyClosed"));
  });

  /**
   * The window stamps outlive the date: only the T+2h tick closes them. A block
   * or a cancellation inside the last hour moves the match off `scheduled`, and
   * that is the only thing that closes this chat before then.
   */
  it("refuses entry to a date that is no longer on, even with the window open", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch({ ...openWindow, status: "cancelled" }));

    const ctx = createCtx({ callbackData: "coord:enter:m1", fromId: 1001 });
    await handleCoordEnter(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    // Not "hope the date went well" — and nothing that names a block.
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordProxyUnavailable"));
  });

  it("leaves another flow alone when a stale Enter button is refused", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch({ ...openWindow, status: "cancelled" }));

    const ctx = createCtx({
      callbackData: "coord:enter:m1",
      fromId: 1001,
      session: { matchFlow: "awaiting_feedback", activeMatchId: "m0" },
    });
    await handleCoordEnter(ctx);

    expect(ctx.session.matchFlow).toBe("awaiting_feedback");
    expect(ctx.session.activeMatchId).toBe("m0");
  });
});

describe("handleCoordExit", () => {
  it("resets the session to idle", async () => {
    const ctx = createCtx({
      callbackData: "coord:exit",
      session: { matchFlow: "coordination_chat", activeMatchId: "m1" },
    });
    await handleCoordExit(ctx);
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
  });
});

describe("handleProxyRelay", () => {
  const openMatch = (over: Record<string, unknown> = {}) => coordMatch({ ...openWindow, ...over });
  const inChat = { matchFlow: "coordination_chat" as const, activeMatchId: "m1" };

  it("forwards text to the partner and logs a ProxyMessage", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch());

    const ctx = createCtx({ messageText: "I'm at the back table", session: inChat, fromId: 1001 });
    await handleProxyRelay(ctx);

    // The author's own copy of the line is recorded, so a reaction from the
    // partner can land where the author will see it.
    expect(mProxy.create).toHaveBeenCalledWith({
      data: {
        matchId: "m1",
        senderId: "uid-A",
        body: "I'm at the back table",
        authorChatMessageId: 77n,
      },
      select: { id: true },
    });
    // Partner (Bob, 1002) gets the relayed message with Leave+Report controls,
    // attributed to the SENDER's first name (Alice) — not the impersonal
    // "Your date:" — since the recipient already knows them by name + photo.
    const call = mockPartnerSend.mock.calls[0];
    expect(call[0]).toBe(1002);
    expect(call[1]).toBe("💬 Alice: I'm at the back table");
    expect(call[1]).not.toContain("Your date");
    const cbs = call[2].reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(cbs).toEqual(["coord:exit", "report:open:m1"]);
    // A rail accepted it, so the sender's row earns its delivery stamp — the
    // same fact the app path records.
    expect(mProxy.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { deliveredAt: expect.any(Date) },
    });
  });

  /**
   * Founder decision 2026-09-26: every scheduled date gets the chat. A pair
   * that never picked anything — no method, no tick stamp yet — is inside the
   * window on the schedule alone, and so is a pair left over from the retired
   * questionnaire that swapped handles.
   */
  it.each([null, "share_self"])(
    "relays for a pair whose coordination method is %s, on the schedule alone",
    async (coordMethod) => {
      mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
      mMatch.findUnique.mockResolvedValueOnce(
        coordMatch({ coordMethod, agreedTime: new Date(Date.now() + 30 * 60 * 1000) }),
      );

      const ctx = createCtx({ messageText: "on my way", session: inChat, fromId: 1001 });
      await handleProxyRelay(ctx);

      expect(mProxy.create).toHaveBeenCalledTimes(1);
      expect(mockPartnerSend.mock.calls[0]![0]).toBe(1002);
      expect(ctx.session.matchFlow).toBe("coordination_chat");
    },
  );

  it("refuses a line two hours before the date, before the window opens", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({ agreedTime: new Date(Date.now() + 2 * 60 * 60 * 1000) }),
    );

    const ctx = createCtx({ messageText: "too early", session: inChat, fromId: 1001 });
    await handleProxyRelay(ctx);

    expect(mProxy.create).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordProxyClosed"));
  });

  it("falls back to the generic prefix when the sender has no first name", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      openMatch({
        userA: coordUser({
          id: "uid-A",
          gender: "female",
          telegramId: 1001n,
          telegramUsername: "alice",
          firstName: null,
        }),
      }),
    );

    const ctx = createCtx({ messageText: "hey", session: inChat, fromId: 1001 });
    await handleProxyRelay(ctx);

    expect(mockPartnerSend.mock.calls[0][1]).toBe("💬 Your date: hey");
  });

  it("rejects media (no text) without relaying or leaving the chat", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch());

    const ctx = createCtx({
      message: { message_id: 78, photo: [{ file_id: "x" }] },
      session: inChat,
      fromId: 1001,
    });
    await handleProxyRelay(ctx);

    expect(mProxy.create).not.toHaveBeenCalled();
    expect(mockPartnerSend).not.toHaveBeenCalled(); // not relayed
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordProxyTextOnly"));
    expect(ctx.session.matchFlow).toBe("coordination_chat"); // stays in chat
  });

  it("self-heals a stale session when the window has closed", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({ proxyOpenedAt: new Date(), proxyClosedAt: new Date() }),
    );

    const ctx = createCtx({ messageText: "hi", session: inChat, fromId: 1001 });
    await handleProxyRelay(ctx);

    expect(mProxy.create).not.toHaveBeenCalled();
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordProxyClosed"));
  });

  it("clamps an over-long message to PROXY_MAX_MESSAGE_LEN", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch());

    const long = "x".repeat(2000);
    const ctx = createCtx({ messageText: long, session: inChat, fromId: 1001 });
    await handleProxyRelay(ctx);

    const stored = mProxy.create.mock.calls[0][0].data.body as string;
    expect(stored.length).toBe(1000);
  });

  /**
   * The security case this leg was missing. A block, an emergency cancel or a
   * freeze inside the last hour moves the match off `scheduled` — but the window
   * stamps stay open until the T+2h tick, and this leg used to read nothing
   * else. The person who was blocked, already sitting in the chat, kept reaching
   * the person who blocked them.
   */
  it("stops relaying the moment the date is no longer on, even inside the window", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" }); // the blocked side
    mMatch.findUnique.mockResolvedValueOnce(openMatch({ status: "cancelled" }));

    const ctx = createCtx({ messageText: "are you there?", session: inChat, fromId: 1002 });
    await handleProxyRelay(ctx);

    expect(mProxy.create).not.toHaveBeenCalled();
    expect(mockPartnerSend).not.toHaveBeenCalled();
    expect(mockSendPush).not.toHaveBeenCalled();
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordProxyUnavailable"));
  });

  it("ends the session on media sent into a date that is no longer on", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch({ status: "cancelled" }));

    const ctx = createCtx({
      message: { message_id: 79, photo: [{ file_id: "x" }] },
      session: inChat,
      fromId: 1002,
    });
    await handleProxyRelay(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.reply).not.toHaveBeenCalledWith(t("en", "coordProxyTextOnly"));
  });

  /**
   * Most pairs here are one Telegram side and one app side, and a Telegram-login
   * app account carries a REAL positive id. This leg used to DM anything with a
   * positive id — a 403 for that partner, read as them blocking the bot — and
   * never pushed, so they learned of "I'm by the door" by opening the app.
   */
  it("pushes an app-only partner and never DMs their Telegram id", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      openMatch({
        userB: coordUser({ id: "uid-B", gender: "male", telegramId: 1002n, platform: "mobile", firstName: "Bob" }),
      }),
    );

    const ctx = createCtx({ messageText: "I'm by the door", session: inChat, fromId: 1001 });
    await handleProxyRelay(ctx);

    expect(mockPartnerSend).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    expect(mockSendPush).toHaveBeenCalledWith(
      "uid-B",
      expect.objectContaining({ body: "I'm by the door", data: { type: "proxy.message", matchId: "m1" } }),
    );
  });
});
