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
  handleCoordMethod,
  handleCoordConsent,
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
// handleCoordMethod
// ---------------------------------------------------------------------------

describe("handleCoordMethod", () => {
  it("share_self (A) DMs the partner a t.me link and locks the method", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:share_self", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "scheduled", coordMethod: null },
      data: expect.objectContaining({
        coordMethod: "share_self",
        coordInitiatorId: "uid-A",
        coordResolvedAt: expect.any(Date),
      }),
    });
    // Partner (Bob, 1002) receives ONE message: the card, with Alice's link as
    // its caption. The link has to stay in the caption — nothing on a PNG is
    // tappable.
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    const dm = ctx.api.sendPhoto.mock.calls[0];
    expect(dm[0]).toBe(1002);
    expect(dm[2].caption).toContain("https://t.me/alice");
    expect(mockRenderCard).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "shared", personPhotoRef: "file-alice-1" }),
      expect.anything(),
    );
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("request_partner (B) DMs the partner an approve/decline keyboard", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:request_partner", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "scheduled", coordMethod: null },
      data: expect.objectContaining({ coordMethod: "request_partner", coordPartnerConsent: null }),
    });
    const call = ctx.api.sendPhoto.mock.calls[0];
    expect(call[0]).toBe(1002);
    // The keyboard rides the photo, so the consent buttons sit under the card
    // rather than on a second message.
    const cbs = call[2].reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(cbs).toEqual(["coord:approve:m1", "coord:decline:m1"]);
    // The face in the frame is the ASKER, so the partner sees who is asking.
    expect(mockRenderCard).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "ask", personPhotoRef: "file-alice-1" }),
      expect.anything(),
    );
  });

  it("proxy (C) locks the method with NO partner DM (unconditional open later)", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:proxy", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "scheduled", coordMethod: null },
      data: expect.objectContaining({ coordMethod: "proxy", coordResolvedAt: expect.any(Date) }),
    });
    expect(ctx.api.sendMessage).not.toHaveBeenCalled(); // partner is not asked
    expect(ctx.api.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("rejects a non-recipient (the male in an M/F pair cannot pick)", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" }); // Bob taps
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:proxy", fromId: 1002 });
    await handleCoordMethod(ctx);

    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("never locks a contact variant whose link cannot exist", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({
        userA: coordUser({ id: "uid-A", gender: "female", telegramId: 1001n, telegramUsername: null }),
      }),
    );

    const ctx = createCtx({ callbackData: "coord:m:m1:share_self", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  /**
   * A same-sex pair both hold the offer, so two taps can both read
   * `coordMethod: null`. The claim is what decides, and the loser must send
   * nothing: a plain update used to let the second tap overwrite the first's
   * choice after the first's card had already reached the partner.
   */
  it("a tap that loses the claim gets the already-chosen notice and sends nothing", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch()); // read before the winner wrote
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });

    const ctx = createCtx({ callbackData: "coord:m:m1:share_self", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.update).not.toHaveBeenCalled();
    expect(ctx.api.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordAlreadyChosen"));
  });
});

// ---------------------------------------------------------------------------
// handleCoordConsent (Variant B)
// ---------------------------------------------------------------------------

describe("handleCoordConsent", () => {
  const base = () =>
    coordMatch({ coordMethod: "request_partner", coordInitiatorId: "uid-A", coordPartnerConsent: null });
  const unanswered = {
    id: "m1",
    status: "scheduled",
    coordMethod: "request_partner",
    coordPartnerConsent: null,
  };

  it("approve reveals the partner's t.me link to the initiator", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" }); // Bob approves
    mMatch.findUnique.mockResolvedValueOnce(base());

    const ctx = createCtx({ callbackData: "coord:approve:m1", fromId: 1002 });
    await handleCoordConsent(ctx);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: unanswered,
      data: { coordPartnerConsent: true, coordResolvedAt: expect.any(Date) },
    });
    // Initiator (Alice, 1001) receives Bob's link in the card's caption.
    const dm = ctx.api.sendPhoto.mock.calls[0];
    expect(dm[0]).toBe(1001);
    expect(dm[2].caption).toContain("https://t.me/bob");
    expect(mockRenderCard).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "shared", personPhotoRef: "file-alice-1" }),
      expect.anything(),
    );
  });

  /**
   * The decline card tells the initiator the anonymous chat opens about an hour
   * before — and `openProxies` opens a window only for `coordMethod: "proxy"`.
   * Recording the refusal while leaving the method on `request_partner` made
   * that promise one nothing kept.
   */
  it("decline notifies the initiator, reveals no contact, and moves the pair onto the anonymous chat", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });
    mMatch.findUnique.mockResolvedValueOnce(base());

    const ctx = createCtx({ callbackData: "coord:decline:m1", fromId: 1002 });
    await handleCoordConsent(ctx);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: unanswered,
      data: { coordPartnerConsent: false, coordMethod: "proxy", coordResolvedAt: expect.any(Date) },
    });
    expect(mMatch.update).not.toHaveBeenCalled();
    expect(ctx.api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendPhoto.mock.calls[0][2].caption).not.toContain("t.me");
    // No face on the decline card — it is about the decision, not the person.
    expect(mockRenderCard).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "declined" }),
      expect.anything(),
    );
    expect(mockRenderCard.mock.calls[0]![0]).not.toHaveProperty("personPhotoRef");
  });

  it("rejects the initiator trying to approve on the partner's behalf", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" }); // initiator taps
    mMatch.findUnique.mockResolvedValueOnce(base());

    const ctx = createCtx({ callbackData: "coord:approve:m1", fromId: 1001 });
    await handleCoordConsent(ctx);

    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  /** Approve and decline tapped together both read an unanswered request. */
  it("an answer that loses the claim sends nothing", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });
    mMatch.findUnique.mockResolvedValueOnce(base());
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });

    const ctx = createCtx({ callbackData: "coord:approve:m1", fromId: 1002 });
    await handleCoordConsent(ctx);

    expect(ctx.api.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("en", "coordAlreadyChosen"));
  });

  /**
   * A Telegram-login app account carries a REAL positive id and no bot chat.
   * `telegramId > 0n` let the card go out; the 403 that came back is read as
   * the person blocking the bot.
   */
  it("sends no Telegram card to an initiator the bot cannot reach", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({
        coordMethod: "request_partner",
        coordInitiatorId: "uid-A",
        userA: coordUser({ id: "uid-A", gender: "female", telegramId: 1001n, platform: "mobile" }),
      }),
    );

    const ctx = createCtx({ callbackData: "coord:decline:m1", fromId: 1002 });
    await handleCoordConsent(ctx);

    expect(mMatch.updateMany).toHaveBeenCalled();
    expect(ctx.api.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Proxy enter / exit / relay (Variant C)
// ---------------------------------------------------------------------------

const openWindow = {
  coordMethod: "proxy",
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
      coordMatch({ coordMethod: "proxy", proxyOpenedAt: new Date(), proxyClosedAt: new Date() }),
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
      coordMatch({ coordMethod: "proxy", proxyOpenedAt: new Date(), proxyClosedAt: new Date() }),
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
