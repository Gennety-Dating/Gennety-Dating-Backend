import type { Api, RawApi } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t, VENUE_FINALIZE_MIN_LEAD_MS } from "@gennety/shared";

const matchFindUnique = vi.fn();
const matchUpdateMany = vi.fn();
const matchFindMany = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique, updateMany: matchUpdateMany, findMany: matchFindMany },
  },
}));

const startScheduling = vi.fn();
vi.mock("../handlers/matching/scheduler.js", () => ({ startScheduling }));

const refreshStatusBanners = vi.fn();
vi.mock("./status-banner-refresh.js", () => ({ refreshStatusBanners }));

const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser }));

const getBotApi = vi.fn();
vi.mock("../public/server.js", () => ({ getBotApi }));

const {
  returnLapsedVenueStageToCalendar,
  sweepLapsedVenueNegotiations,
  venueSlotStillAhead,
} = await import("./venue-time-lapse.js");

const NOW = new Date("2026-09-14T11:00:00.000Z");
const MINUTE = 60_000;

function fakeApi() {
  return { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
}
type FakeApi = ReturnType<typeof fakeApi>;
const asApi = (api: FakeApi) => api as unknown as Api<RawApi>;

function lapsedRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "negotiating_venue",
    // Locked for noon; it is 11:00 and the venue is still being chosen.
    agreedTime: new Date(NOW.getTime() + 10 * MINUTE),
    venueIntentA: { rawText: "quiet cafe", state: "confirmed", confirmedAt: "2026-09-14T10:00:00Z", origin: { lat: 50.45, lng: 30.52 } },
    venueIntentB: { rawText: "park walk", state: "draft", confirmedAt: null },
    userAId: "a",
    userBId: "b",
    userA: { id: "a", telegramId: 100n, platform: "telegram", language: "en" },
    userB: { id: "b", telegramId: 0n, platform: "mobile", language: "ru" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  matchUpdateMany.mockResolvedValue({ count: 1 });
  startScheduling.mockResolvedValue(undefined);
  refreshStatusBanners.mockResolvedValue(undefined);
  sendPushToUser.mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("venueSlotStillAhead", () => {
  it("needs strictly more than the lead between now and the date", () => {
    expect(venueSlotStillAhead(new Date(NOW.getTime() + VENUE_FINALIZE_MIN_LEAD_MS + 1), NOW)).toBe(true);
    expect(venueSlotStillAhead(new Date(NOW.getTime() + VENUE_FINALIZE_MIN_LEAD_MS), NOW)).toBe(false);
    expect(venueSlotStillAhead(new Date(NOW.getTime() - MINUTE), NOW)).toBe(false);
  });
});

describe("returnLapsedVenueStageToCalendar (A13-H5)", () => {
  it("moves a lapsed venue stage back to the calendar, CAS-guarded on the time it read", async () => {
    const row = lapsedRow();
    matchFindUnique.mockResolvedValue(row);
    const api = fakeApi();

    const moved = await returnLapsedVenueStageToCalendar("m1", { api: asApi(api), now: NOW });

    expect(moved).toBe(true);
    const write = matchUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(write.where).toEqual({ id: "m1", status: "negotiating_venue", agreedTime: row.agreedTime });
    expect(write.data).toMatchObject({
      status: "negotiating",
      agreedTime: null,
      venuePromptAskedAt: null,
      vibeTextA: null,
      vibeLatB: null,
      venueSelectionAttempts: 0,
      venueSelectionNextRetryAt: null,
      venueNudge1SentAt: null,
      schedNudge2SentAt: null,
      availableTimesA: [],
      availableTimesB: [],
    });
    // Emptied, not regenerated: `startScheduling` opens a fresh grid only on
    // an empty one, and stamps the new phase anchor when it does.
    expect(write.data.proposedTimes).toEqual([]);
  });

  it("keeps a confirmed V2 intent as a draft, so reopening restores it and a new Confirm re-selects", async () => {
    matchFindUnique.mockResolvedValue(lapsedRow());

    await returnLapsedVenueStageToCalendar("m1", { api: asApi(fakeApi()), now: NOW });

    const data = matchUpdateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.venueIntentA).toEqual({
      rawText: "quiet cafe",
      state: "draft",
      confirmedAt: null,
      origin: { lat: 50.45, lng: 30.52 },
    });
    // Already a draft: left untouched rather than rewritten.
    expect("venueIntentB" in data).toBe(false);
  });

  it("explains first, then reopens the calendar as a fresh card", async () => {
    matchFindUnique.mockResolvedValue(lapsedRow());
    const api = fakeApi();

    await returnLapsedVenueStageToCalendar("m1", { api: asApi(api), now: NOW });

    expect(api.sendMessage).toHaveBeenCalledWith(100, t("en", "venueTimeLapsedBackToCalendar"));
    // The mobile-only side cannot get a chat message, so it gets the push.
    expect(sendPushToUser).toHaveBeenCalledWith(
      "b",
      expect.objectContaining({ body: t("ru", "venueTimeLapsedBackToCalendar") }),
    );
    expect(startScheduling).toHaveBeenCalledWith(api, "m1", { afterTicketGate: true });
    expect(api.sendMessage.mock.invocationCallOrder[0]!).toBeLessThan(
      startScheduling.mock.invocationCallOrder[0]!,
    );
    expect(refreshStatusBanners).toHaveBeenCalledWith(api, ["a", "b"]);
  });

  it("does nothing while the date still has its runway", async () => {
    matchFindUnique.mockResolvedValue(
      lapsedRow({ agreedTime: new Date(NOW.getTime() + VENUE_FINALIZE_MIN_LEAD_MS + MINUTE) }),
    );
    const api = fakeApi();

    expect(await returnLapsedVenueStageToCalendar("m1", { api: asApi(api), now: NOW })).toBe(false);
    expect(matchUpdateMany).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("tells nobody when a venue lock or another sweep won the row", async () => {
    matchFindUnique.mockResolvedValue(lapsedRow());
    matchUpdateMany.mockResolvedValue({ count: 0 });
    const api = fakeApi();

    expect(await returnLapsedVenueStageToCalendar("m1", { api: asApi(api), now: NOW })).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(startScheduling).not.toHaveBeenCalled();
  });

  it("moves nothing without a Bot API — the sweep, which has one, takes it", async () => {
    matchFindUnique.mockResolvedValue(lapsedRow());
    getBotApi.mockReturnValue(null);

    expect(await returnLapsedVenueStageToCalendar("m1", { now: NOW })).toBe(false);
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });
});

describe("sweepLapsedVenueNegotiations", () => {
  it("takes venue stages whose date is inside the lead, oldest first, and survives a bad row", async () => {
    matchFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    matchFindUnique
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(lapsedRow());
    vi.spyOn(console, "error").mockImplementation(() => {});

    const returned = await sweepLapsedVenueNegotiations(asApi(fakeApi())!, NOW);

    expect(returned).toBe(1);
    const query = matchFindMany.mock.calls[0]![0] as {
      where: { status: string; agreedTime: { lte: Date } };
      orderBy: unknown;
    };
    expect(query.where.status).toBe("negotiating_venue");
    expect(query.where.agreedTime.lte.getTime()).toBe(NOW.getTime() + VENUE_FINALIZE_MIN_LEAD_MS);
    expect(query.orderBy).toEqual({ agreedTime: "asc" });
  });
});
