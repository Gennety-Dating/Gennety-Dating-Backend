import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    match: { findMany: vi.fn() },
  },
}));

vi.mock("@gennety/db", () => ({ prisma: mockPrisma }));

import { buildStatusBannerView } from "../services/status-banner.js";
import { resolveBannerStage, statusTimerTick } from "./status-timer.js";

const NOW = new Date("2026-07-21T09:00:00.000Z");

function telegramError(code: number, description: string, retryAfter?: number): GrammyError {
  return new GrammyError(
    description,
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    },
    "editMessageText",
    {},
  );
}

function active(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    telegramId: 42n,
    language: "ru",
    status: "active",
    statusMessageId: 100,
    ...overrides,
  };
}

/** A live-match row shaped like the worker's own `select`. `u1` is side A. */
function liveMatch(overrides: Record<string, unknown> = {}) {
  return {
    status: "negotiating",
    userAId: "u1",
    userBId: "u2",
    agreedTime: null,
    venueName: null,
    dispatchedAt: null,
    acceptedByA: null,
    acceptedByB: null,
    pitchMessageIdA: null,
    pitchMessageIdB: null,
    ...overrides,
  };
}

function makeApi() {
  return {
    unpinAllChatMessages: vi.fn().mockResolvedValue(true),
    unpinChatMessage: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    getChat: vi.fn().mockResolvedValue({ pinned_message: { message_id: 100 } }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.user.update.mockResolvedValue({});
  mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.match.findMany.mockResolvedValue([]);
});

describe("statusTimerTick", () => {
  it("self-heals an active user with a null DB pointer", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active({ statusMessageId: null })]);
    const api = makeApi();

    const result = await statusTimerTick(api, { now: NOW });

    expect(result.created).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("✦ GENNETY DROP"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(api.pinChatMessage).toHaveBeenCalledWith(42, 555, {
      disable_notification: true,
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: 42n },
      data: { statusMessageId: 555 },
    });
  });

  // PRODUCT_SPEC §2.1 — a scheduled date OWNS the banner: the user is out of
  // the weekly batch (§3.2 filter 8), so the drop countdown is replaced rather
  // than supplemented.
  it("replaces the drop countdown with the date countdown", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    mockPrisma.match.findMany.mockResolvedValue([
      liveMatch({
        status: "scheduled",
        agreedTime: new Date("2026-07-21T18:00:00.000Z"),
        venueName: "Blur Cafe",
      }),
    ]);
    const api = makeApi();

    const result = await statusTimerTick(api, {
      now: NOW,
      forcePinAudit: true,
      renderCache: new Map(),
    });

    expect(result.edited).toBe(1);
    const [, , text, options] = api.editMessageText.mock.calls[0]!;
    expect(text).toContain("Blur Cafe");
    expect(text).not.toContain("Следующий дроп");
    expect(options.reply_markup.inline_keyboard[0][0]).toEqual(
      expect.objectContaining({
        callback_data: "menu:date",
        style: "primary",
      }),
    );
    expect(options.reply_markup.inline_keyboard[0][0].text).toContain("Свидание через");
  });

  it("shows the reply deadline while the user's own decision is open", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    mockPrisma.match.findMany.mockResolvedValue([
      liveMatch({
        status: "proposed",
        dispatchedAt: new Date("2026-07-21T03:40:00.000Z"),
        pitchMessageIdA: 7,
      }),
    ]);
    const api = makeApi();

    const result = await statusTimerTick(api, { now: NOW, renderCache: new Map() });

    expect(result.edited).toBe(1);
    const [, , text, options] = api.editMessageText.mock.calls[0]!;
    expect(text).toContain("Твой мэтч ждёт ответа");
    expect(options.reply_markup.inline_keyboard[0][0].text).toBe(
      "⏳ Осталось на ответ: 18ч 40м",
    );
    expect(options.reply_markup.inline_keyboard[0][0].callback_data).toBe("menu:date");
  });

  it("ignores a proposed match whose pitch has not reached this side yet", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    mockPrisma.match.findMany.mockResolvedValue([
      liveMatch({
        status: "proposed",
        dispatchedAt: new Date("2026-07-21T03:40:00.000Z"),
        pitchMessageIdA: null,
        pitchMessageIdB: 9,
      }),
    ]);
    const api = makeApi();

    await statusTimerTick(api, { now: NOW, renderCache: new Map() });

    const [, , text] = api.editMessageText.mock.calls[0]!;
    expect(text).toContain("✦ GENNETY DROP");
  });

  it("prefers the most progressed row when legacy data has several live matches", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    mockPrisma.match.findMany.mockResolvedValue([
      liveMatch({ status: "negotiating" }),
      liveMatch({
        status: "scheduled",
        agreedTime: new Date("2026-07-21T18:00:00.000Z"),
        venueName: "Blur Cafe",
      }),
    ]);
    const api = makeApi();

    await statusTimerTick(api, { now: NOW, renderCache: new Map() });

    const [, , text] = api.editMessageText.mock.calls[0]!;
    expect(text).toContain("Blur Cafe");
  });

  it("re-pins a tracked message during the hourly physical audit", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.getChat.mockResolvedValue({ pinned_message: { message_id: 999 } });
    const signature = buildStatusBannerView("ru", { now: NOW }).signature;

    const result = await statusTimerTick(api, {
      now: NOW,
      forcePinAudit: true,
      renderCache: new Map([["42", signature]]),
    });

    expect(result.repinned).toBe(1);
    expect(api.pinChatMessage).toHaveBeenCalledWith(42, 100, {
      disable_notification: true,
    });
  });

  it("replaces a deleted Telegram message in the same tick", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(
      telegramError(400, "Bad Request: message to edit not found"),
    );

    const result = await statusTimerTick(api, { now: NOW, renderCache: new Map() });

    expect(result.created).toBe(1);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", statusMessageId: 100 },
      data: { statusMessageId: null },
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    "paused",
    "frozen",
    "suspended",
    "pending_investigation",
    "banned",
  ])("clears a tracked banner for a %s account", async (status) => {
    mockPrisma.user.findMany.mockResolvedValue([active({ status })]);
    const api = makeApi();

    const result = await statusTimerTick(api, { now: NOW });

    expect(result.removedInactive).toBe(1);
    expect(api.unpinChatMessage).toHaveBeenCalledWith(42, 100);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", statusMessageId: 100 },
      data: { statusMessageId: null },
    });
  });

  it("keeps an inactive pointer when unpinning fails transiently", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active({ status: "paused" })]);
    const api = makeApi();
    api.unpinChatMessage.mockRejectedValue(new Error("network reset"));
    const retryState = new Map();

    const result = await statusTimerTick(api, { now: NOW, retryState });

    expect(result.transientFailures).toBe(1);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(retryState.get("42").retryAt).toBeGreaterThan(NOW.getTime());

    api.unpinChatMessage.mockClear();
    await statusTimerTick(api, {
      now: new Date(NOW.getTime() + 30_000),
      retryState,
    });
    expect(api.unpinChatMessage).not.toHaveBeenCalled();
  });

  it("honours retry_after and does not retry every minute", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(
      telegramError(429, "Too Many Requests", 120),
    );
    const retryState = new Map();

    const first = await statusTimerTick(api, {
      now: NOW,
      retryState,
      renderCache: new Map(),
    });
    expect(first.transientFailures).toBe(1);

    api.editMessageText.mockClear();
    const second = await statusTimerTick(api, {
      now: new Date(NOW.getTime() + 60_000),
      retryState,
      renderCache: new Map(),
    });
    expect(second.unchanged).toBe(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it.each([
    ["5xx", telegramError(503, "Service Unavailable")],
    ["network", new Error("network reset")],
  ])("backs off after a transient %s failure", async (_label, error) => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(error);
    const retryState = new Map();

    const result = await statusTimerTick(api, {
      now: NOW,
      retryState,
      renderCache: new Map(),
    });

    expect(result.transientFailures).toBe(1);
    expect(retryState.get("42").retryAt).toBeGreaterThan(NOW.getTime());
  });

  it("clears an unreachable pointer and applies a long cooldown", async () => {
    mockPrisma.user.findMany.mockResolvedValue([active()]);
    const api = makeApi();
    api.editMessageText.mockRejectedValue(
      telegramError(403, "Forbidden: bot was blocked by the user"),
    );
    const retryState = new Map();

    const result = await statusTimerTick(api, {
      now: NOW,
      retryState,
      renderCache: new Map(),
    });

    expect(result.permanentFailures).toBe(1);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", statusMessageId: 100 },
      data: { statusMessageId: null },
    });
    expect(retryState.get("42").retryAt).toBeGreaterThan(
      NOW.getTime() + 5 * 60 * 60 * 1000,
    );
  });
});

// The whole product decision of PRODUCT_SPEC §2.1 lives in this pure function.
describe("resolveBannerStage", () => {
  const scheduled = (agreedTime: Date | null, venueName: string | null = "Blur Cafe") =>
    liveMatch({ status: "scheduled", agreedTime, venueName }) as never;

  it("counts down to a future date", () => {
    const at = new Date("2026-07-23T15:00:00.000Z");
    expect(resolveBannerStage(scheduled(at), "A", NOW)).toEqual({
      kind: "date",
      at,
      venueName: "Blur Cafe",
    });
  });

  // The row lingers until the T+24h feedback flow closes it; by then the next
  // drop is genuinely the relevant thing again.
  it("falls back to the drop countdown once the date has passed", () => {
    expect(
      resolveBannerStage(scheduled(new Date("2026-07-20T15:00:00.000Z")), "A", NOW),
    ).toBeUndefined();
    expect(resolveBannerStage(scheduled(null), "A", NOW)).toBeUndefined();
  });

  it("reads only the caller's own side of the decision", () => {
    const match = liveMatch({
      status: "proposed",
      dispatchedAt: new Date("2026-07-21T03:00:00.000Z"),
      acceptedByA: true,
      acceptedByB: null,
    }) as never;

    // A already answered — waiting on the peer, never revealing their choice.
    expect(resolveBannerStage(match, "A", NOW)).toEqual({ kind: "planning" });
    // B still owes an answer.
    expect(resolveBannerStage(match, "B", NOW)).toEqual({
      kind: "decision",
      minutesLeft: 18 * 60,
    });
  });

  // A first decider leaves the row `proposed` whichever way they went (§3.4),
  // so both verdicts reach this function and they mean opposite things. A pass
  // must never produce a banner about the date they just declined.
  it("shows nothing at all to a side that declined", () => {
    const match = liveMatch({
      status: "proposed",
      dispatchedAt: new Date("2026-07-21T03:00:00.000Z"),
      acceptedByA: false,
      acceptedByB: null,
    }) as never;

    expect(resolveBannerStage(match, "A", NOW)).toBeUndefined();
    // The peer's own window is untouched by the decline.
    expect(resolveBannerStage(match, "B", NOW)).toEqual({
      kind: "decision",
      minutesLeft: 18 * 60,
    });
  });

  // Past the TTL the expiry cron owns the row (≤15 min behind), so claiming
  // there is still time to answer would be false.
  it("falls back to the drop countdown for an expired proposal", () => {
    const match = liveMatch({
      status: "proposed",
      dispatchedAt: new Date("2026-07-20T08:00:00.000Z"),
    }) as never;
    expect(resolveBannerStage(match, "A", NOW)).toBeUndefined();
  });

  it("treats an undispatched proposal as no stage at all", () => {
    const match = liveMatch({ status: "proposed", dispatchedAt: null }) as never;
    expect(resolveBannerStage(match, "A", NOW)).toBeUndefined();
  });

  it.each(["negotiating", "negotiating_venue"] as const)(
    "shows the planning stage during %s",
    (status) => {
      expect(resolveBannerStage(liveMatch({ status }) as never, "A", NOW)).toEqual({
        kind: "planning",
      });
    },
  );
});
