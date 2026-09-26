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
    match: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

// The proxy-open DM rides a rendered PNG (PRODUCT_SPEC §Phase 4).
// Stub the raster — a real satori render costs seconds per call and says
// nothing about the sweep; `coordination-card/send.test.ts` covers delivery.
const { mockRenderCard } = vi.hoisted(() => ({
  mockRenderCard: vi.fn().mockResolvedValue(Buffer.from("png")),
}));
vi.mock("./coordination-card/index.js", () => ({ renderCoordinationCard: mockRenderCard }));

const { mockSendPush, mockAdvanceActivities } = vi.hoisted(() => ({
  mockSendPush: vi.fn().mockResolvedValue(true),
  mockAdvanceActivities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./push.js", () => ({ sendPushToUser: mockSendPush }));
vi.mock("./date-day-activity.js", () => ({ advanceDateDayActivities: mockAdvanceActivities }));

import { prisma } from "@gennety/db";
import { runCoordinationTick, isProxyOpen } from "./coordination.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; update: MockFn; updateMany: MockFn };

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const NOW = new Date("2026-06-04T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.COORDINATION_FEATURE_ENABLED = true;
  // Default: every phase query returns empty.
  mMatch.findMany.mockResolvedValue([]);
  mMatch.update.mockResolvedValue({});
  mMatch.updateMany.mockResolvedValue({ count: 1 });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isProxyOpen", () => {
  it("true inside the window", () => {
    expect(
      isProxyOpen(
        { proxyOpenedAt: NOW, proxyClosedAt: null, proxyClosesAt: new Date(NOW.getTime() + 1) },
        NOW,
      ),
    ).toBe(true);
  });
  it("false once closed", () => {
    expect(
      isProxyOpen({ proxyOpenedAt: NOW, proxyClosedAt: NOW, proxyClosesAt: new Date(NOW.getTime() + 1) }, NOW),
    ).toBe(false);
  });
  it("false past the close time", () => {
    expect(
      isProxyOpen({ proxyOpenedAt: NOW, proxyClosedAt: null, proxyClosesAt: new Date(NOW.getTime() - 1) }, NOW),
    ).toBe(false);
  });
  it("false before it opened", () => {
    expect(isProxyOpen({ proxyOpenedAt: null, proxyClosedAt: null, proxyClosesAt: null }, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runCoordinationTick
// ---------------------------------------------------------------------------

describe("runCoordinationTick — feature flag", () => {
  it("is a no-op when the flag is off (no queries at all)", async () => {
    mockEnv.COORDINATION_FEATURE_ENABLED = false;
    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);
    expect(res).toEqual({ opened: 0, closed: 0 });
    expect(mMatch.findMany).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });
});

/**
 * Founder decision 2026-09-26: the T-3h questionnaire (share my Telegram / ask
 * for theirs / anonymous chat) is gone. A date three hours out is not the
 * tick's business at all — it reads the T-1h open window and the T+2h close
 * sweep, and nothing else.
 */
describe("runCoordinationTick — no coordination offer", () => {
  it("sends nothing and writes nothing for a date three hours out", async () => {
    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res).toEqual({ opened: 0, closed: 0 });
    expect(mMatch.findMany).toHaveBeenCalledTimes(2); // open + close, no offer sweep
    const openQuery = mMatch.findMany.mock.calls[0]![0];
    expect(openQuery.where.agreedTime).toEqual({
      gt: NOW,
      lte: new Date(NOW.getTime() + 60 * 60 * 1000),
    });
    // Neither sweep reads or filters on the retired questionnaire's columns.
    const queries = JSON.stringify(mMatch.findMany.mock.calls, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(queries).not.toMatch(/coordOfferSentAt|coordMethod|coordPartnerConsent/);
    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mockSendPush).not.toHaveBeenCalled();
  });
});

describe("runCoordinationTick — open proxy (T-1h, unconditional)", () => {
  const agreedTime = new Date(NOW.getTime() + 20 * 60 * 1000); // 20 min out
  const openRow = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    agreedTime,
    userA: { id: "A", telegramId: 1001n, language: "en" },
    userB: { id: "B", telegramId: 1002n, language: "en" },
    ...over,
  });

  it("opens for both with no consent gate and sets proxyClosesAt = agreed + 2h", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([openRow()])
      .mockResolvedValueOnce([]); // close phase

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.opened).toBe(1);
    // Both sides get the card + Enter button. No photo goes ON this card — the
    // withheld portrait IS the card, and a face would contradict it.
    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mockRenderCard).toHaveBeenCalledWith(expect.objectContaining({ variant: "proxy" }));
    expect(mockRenderCard.mock.calls[0]![0]).not.toHaveProperty("personPhotoRef");
    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "scheduled", proxyOpenedAt: null },
      data: {
        proxyOpenedAt: NOW,
        proxyClosesAt: new Date(agreedTime.getTime() + 2 * 60 * 60 * 1000),
      },
    });
  });

  /**
   * The stamp used to be written AFTER the cards went out, so two overlapping
   * ticks both read `proxyOpenedAt: null` and both announced the chat. The claim
   * now comes first, and a tick that loses it — or finds the date cancelled in
   * between — tells nobody anything.
   */
  it("announces nothing when another tick has already claimed the open", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([openRow()])
      .mockResolvedValueOnce([]);
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.opened).toBe(0);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Founder decision 2026-09-26: every scheduled date gets the chat. The open
   * query asks for a scheduled date inside the hour and nothing else — no
   * method, no consent — so a pair that never chose anything (the Telegram-only
   * pair whose initiator ignored the old offer used to get NO chat) opens like
   * any other.
   */
  it("opens for every scheduled date in the hour, whatever was or wasn't chosen", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([openRow()])
      .mockResolvedValueOnce([]);

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    const openQuery = mMatch.findMany.mock.calls[0]![0];
    expect(openQuery.where).toEqual({
      status: "scheduled",
      proxyOpenedAt: null,
      agreedTime: { gt: NOW, lte: new Date(NOW.getTime() + 60 * 60 * 1000) },
    });
    expect(res.opened).toBe(1);
    expect(mockAdvanceActivities).toHaveBeenCalledWith("m1", "chat_open");
  });

  it("tells each side on its own rail: a push on the app, a card on Telegram", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([
        openRow({
          userA: { id: "A", telegramId: 1001n, platform: "telegram", language: "en" },
          userB: { id: "B", telegramId: -7n, platform: "mobile", language: "en" },
        }),
      ])
      .mockResolvedValueOnce([]);

    const api = makeApi();
    await runCoordinationTick(api, NOW);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto.mock.calls[0]![0]).toBe(1001);
    expect(mockSendPush).toHaveBeenCalledTimes(1);
    expect(mockSendPush).toHaveBeenCalledWith(
      "B",
      expect.objectContaining({ data: { type: "proxy.opened", matchId: "m1" } }),
    );
  });
});

describe("runCoordinationTick — close proxy (T+2h)", () => {
  const closeRow = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    status: "scheduled",
    userA: { telegramId: 1001n, platform: "telegram", language: "en" },
    userB: { telegramId: 1002n, platform: "telegram", language: "en" },
    ...over,
  });

  it("stamps proxyClosedAt and DMs both", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([]) // open
      .mockResolvedValueOnce([closeRow()]);

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    // Closed for any pair whose window was announced — no method filter.
    expect(mMatch.findMany.mock.calls[1]![0].where).toEqual({
      proxyOpenedAt: { not: null },
      proxyClosedAt: null,
      proxyClosesAt: { lte: NOW },
    });
    expect(res.closed).toBe(1);
    // The close notice stays plain text — there is no card for "it's over".
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { proxyClosedAt: NOW },
    });
  });

  /**
   * "Hope the date went well — I'll check in tomorrow" to someone whose date was
   * cancelled, or who was blocked, contradicts the notice they already got. The
   * window is still stamped shut.
   */
  it("closes a called-off date's chat silently", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([closeRow({ status: "cancelled" })]);

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.closed).toBe(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { proxyClosedAt: NOW },
    });
  });

  it("still tells a pair whose date has already been marked completed", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([closeRow({ status: "completed" })]);

    const api = makeApi();
    await runCoordinationTick(api, NOW);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  /** A Telegram-login app account has a real id and no bot chat. */
  it("does not DM an app-only account through its real Telegram id", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        closeRow({ userB: { telegramId: 1002n, platform: "mobile", language: "en" } }),
      ]);

    const api = makeApi();
    await runCoordinationTick(api, NOW);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(1001);
  });
});
