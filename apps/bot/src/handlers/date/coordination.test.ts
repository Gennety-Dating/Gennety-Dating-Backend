import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn(), update: vi.fn() },
    proxyMessage: { create: vi.fn() },
  },
}));

vi.mock("../../config.js", () => ({ env: { COORDINATION_FEATURE_ENABLED: true } }));

import { prisma } from "@gennety/db";
import {
  handleCoordMethod,
  handleCoordConsent,
  handleCoordEnter,
  handleCoordExit,
  handleProxyRelay,
} from "./coordination.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn };
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mProxy = prisma.proxyMessage as unknown as { create: MockFn };

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
          ? { text: over.messageText }
          : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

function coordUser(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uid-A",
    telegramId: 1001n,
    language: "en",
    firstName: "Alice",
    gender: "female",
    telegramUsername: "alice",
    ...over,
  };
}

function coordMatch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    status: "scheduled",
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
  mProxy.create.mockResolvedValue({});
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

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1" },
        data: expect.objectContaining({ coordMethod: "share_self", coordInitiatorId: "uid-A" }),
      }),
    );
    // Partner (Bob, 1002) receives Alice's link.
    const dm = ctx.api.sendMessage.mock.calls[0];
    expect(dm[0]).toBe(1002);
    expect(dm[1]).toContain("https://t.me/alice");
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("request_partner (B) DMs the partner an approve/decline keyboard", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:request_partner", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coordMethod: "request_partner", coordPartnerConsent: null }),
      }),
    );
    const call = ctx.api.sendMessage.mock.calls[0];
    expect(call[0]).toBe(1002);
    const cbs = call[2].reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(cbs).toEqual(["coord:approve:m1", "coord:decline:m1"]);
  });

  it("proxy (C) locks the method with NO partner DM (unconditional open later)", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:proxy", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coordMethod: "proxy", coordResolvedAt: expect.any(Date) }),
      }),
    );
    expect(ctx.api.sendMessage).not.toHaveBeenCalled(); // partner is not asked
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("rejects a non-recipient (the male in an M/F pair cannot pick)", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" }); // Bob taps
    mMatch.findUnique.mockResolvedValueOnce(coordMatch());

    const ctx = createCtx({ callbackData: "coord:m:m1:proxy", fromId: 1002 });
    await handleCoordMethod(ctx);

    expect(mMatch.update).not.toHaveBeenCalled();
  });

  it("is idempotent — a second pick gets the already-chosen notice", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(coordMatch({ coordMethod: "proxy", coordInitiatorId: "uid-A" }));

    const ctx = createCtx({ callbackData: "coord:m:m1:share_self", fromId: 1001 });
    await handleCoordMethod(ctx);

    expect(mMatch.update).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCoordConsent (Variant B)
// ---------------------------------------------------------------------------

describe("handleCoordConsent", () => {
  const base = () =>
    coordMatch({ coordMethod: "request_partner", coordInitiatorId: "uid-A", coordPartnerConsent: null });

  it("approve reveals the partner's t.me link to the initiator", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" }); // Bob approves
    mMatch.findUnique.mockResolvedValueOnce(base());

    const ctx = createCtx({ callbackData: "coord:approve:m1", fromId: 1002 });
    await handleCoordConsent(ctx);

    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { coordPartnerConsent: true, coordResolvedAt: expect.any(Date) },
    });
    // Initiator (Alice, 1001) receives Bob's link.
    const dm = ctx.api.sendMessage.mock.calls[0];
    expect(dm[0]).toBe(1001);
    expect(dm[1]).toContain("https://t.me/bob");
  });

  it("decline notifies the initiator and reveals no contact", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });
    mMatch.findUnique.mockResolvedValueOnce(base());

    const ctx = createCtx({ callbackData: "coord:decline:m1", fromId: 1002 });
    await handleCoordConsent(ctx);

    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { coordPartnerConsent: false, coordResolvedAt: expect.any(Date) },
    });
    expect(ctx.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendMessage.mock.calls[0][1]).not.toContain("t.me");
  });

  it("rejects the initiator trying to approve on the partner's behalf", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" }); // initiator taps
    mMatch.findUnique.mockResolvedValueOnce(base());

    const ctx = createCtx({ callbackData: "coord:approve:m1", fromId: 1001 });
    await handleCoordConsent(ctx);

    expect(mMatch.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Proxy enter / exit / relay (Variant C)
// ---------------------------------------------------------------------------

describe("handleCoordEnter", () => {
  it("sets coordination_chat state only inside the open window", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({
        coordMethod: "proxy",
        proxyOpenedAt: new Date("2026-06-04T12:00:00Z"),
        proxyClosesAt: new Date("2030-01-01T00:00:00Z"),
      }),
    );

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
  const openMatch = () =>
    coordMatch({
      coordMethod: "proxy",
      proxyOpenedAt: new Date("2026-06-04T12:00:00Z"),
      proxyClosesAt: new Date("2030-01-01T00:00:00Z"),
    });

  it("forwards text to the partner and logs a ProxyMessage", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch());

    const ctx = createCtx({
      messageText: "I'm at the back table",
      session: { matchFlow: "coordination_chat", activeMatchId: "m1" },
      fromId: 1001,
    });
    await handleProxyRelay(ctx);

    expect(mProxy.create).toHaveBeenCalledWith({
      data: { matchId: "m1", senderId: "uid-A", body: "I'm at the back table" },
    });
    // Partner (Bob, 1002) gets the relayed message with Leave+Report controls,
    // attributed to the SENDER's first name (Alice) — not the impersonal
    // "Your date:" — since the recipient already knows them by name + photo.
    const call = ctx.api.sendMessage.mock.calls[0];
    expect(call[0]).toBe(1002);
    expect(call[1]).toBe("💬 Alice: I'm at the back table");
    expect(call[1]).not.toContain("Your date");
    const cbs = call[2].reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(cbs).toEqual(["coord:exit", "report:open:m1"]);
  });

  it("falls back to the generic prefix when the sender has no first name", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({
        coordMethod: "proxy",
        proxyOpenedAt: new Date("2026-06-04T12:00:00Z"),
        proxyClosesAt: new Date("2030-01-01T00:00:00Z"),
        userA: coordUser({
          id: "uid-A",
          gender: "female",
          telegramId: 1001n,
          telegramUsername: "alice",
          firstName: null,
        }),
      }),
    );

    const ctx = createCtx({
      messageText: "hey",
      session: { matchFlow: "coordination_chat", activeMatchId: "m1" },
      fromId: 1001,
    });
    await handleProxyRelay(ctx);

    const call = ctx.api.sendMessage.mock.calls[0];
    expect(call[1]).toBe("💬 Your date: hey");
  });

  it("rejects media (no text) without relaying or leaving the chat", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch());

    const ctx = createCtx({
      message: { photo: [{ file_id: "x" }] },
      session: { matchFlow: "coordination_chat", activeMatchId: "m1" },
      fromId: 1001,
    });
    await handleProxyRelay(ctx);

    expect(mProxy.create).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled(); // not relayed
    expect(ctx.reply).toHaveBeenCalled(); // text-only notice
    expect(ctx.session.matchFlow).toBe("coordination_chat"); // stays in chat
  });

  it("self-heals a stale session when the window has closed", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(
      coordMatch({ coordMethod: "proxy", proxyOpenedAt: new Date(), proxyClosedAt: new Date() }),
    );

    const ctx = createCtx({
      messageText: "hi",
      session: { matchFlow: "coordination_chat", activeMatchId: "m1" },
      fromId: 1001,
    });
    await handleProxyRelay(ctx);

    expect(mProxy.create).not.toHaveBeenCalled();
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
  });

  it("clamps an over-long message to PROXY_MAX_MESSAGE_LEN", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(openMatch());

    const long = "x".repeat(2000);
    const ctx = createCtx({
      messageText: long,
      session: { matchFlow: "coordination_chat", activeMatchId: "m1" },
      fromId: 1001,
    });
    await handleProxyRelay(ctx);

    const stored = mProxy.create.mock.calls[0][0].data.body as string;
    expect(stored.length).toBe(1000);
  });
});
