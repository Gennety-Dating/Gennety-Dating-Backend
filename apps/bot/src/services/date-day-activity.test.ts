import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: matchFindUnique } },
}));

const sendLiveActivityStartToUser = vi.fn();
const sendLiveActivityUpdateToUser = vi.fn();
vi.mock("./push.js", () => ({ sendLiveActivityStartToUser, sendLiveActivityUpdateToUser }));

const { DATE_DAY_ATTRIBUTES_TYPE, advanceDateDayActivities, endDateDayActivities, startDateDayActivities } =
  await import("./date-day-activity.js");

const NOW = new Date("2026-08-10T12:00:00.000Z");
const DATE_AT = new Date("2026-08-10T17:00:00.000Z");

function matchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    agreedTime: DATE_AT,
    venueName: "Aroma Kava",
    venueAddress: "Khreshchatyk 14",
    venueGoogleMapsUri: "https://maps.google.com/?cid=1",
    userA: { id: "ua", language: "ru" },
    userB: { id: "ub", language: "en" },
    ...overrides,
  };
}

beforeEach(() => {
  matchFindUnique.mockReset();
  sendLiveActivityStartToUser.mockReset().mockResolvedValue(true);
  sendLiveActivityUpdateToUser.mockReset().mockResolvedValue(true);
});

describe("startDateDayActivities", () => {
  it("push-starts both sides with the venue and a localized alert", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await startDateDayActivities("m1", NOW);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    const [userId, type, payload] = sendLiveActivityStartToUser.mock.calls[0]!;
    expect(userId).toBe("ua");
    expect(type).toBe("date_day");
    expect(payload.attributesType).toBe(DATE_DAY_ATTRIBUTES_TYPE);
    expect(payload.attributes).toEqual({
      matchId: "m1",
      startsAt: Math.floor(DATE_AT.getTime() / 1000),
      venueName: "Aroma Kava",
      venueAddress: "Khreshchatyk 14",
      mapsUrl: "https://maps.google.com/?cid=1",
    });
    expect(payload.contentState).toEqual({ stage: "icebreakers" });
    // Stale at the date itself: that is what flips the card into its
    // "you're there" look with no push behind it.
    expect(payload.staleDate).toBe(Math.floor(DATE_AT.getTime() / 1000));

    // Each side is alerted in its OWN language, not the pair's or the caller's.
    expect(payload.alert.title).toBe("Сегодня свидание");
    expect(sendLiveActivityStartToUser.mock.calls[1]![2].alert.title).toBe("Your date is today");
  });

  it("carries the place and nothing about the person", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    await startDateDayActivities("m1", NOW);
    const payload = sendLiveActivityStartToUser.mock.calls[0]![2];
    // The lock screen is public. Pinned as an exact key set rather than an
    // absence check, so a field added later has to be argued for here first.
    expect(Object.keys(payload.attributes).sort()).toEqual([
      "mapsUrl",
      "matchId",
      "startsAt",
      "venueAddress",
      "venueName",
    ]);
    expect(Object.keys(payload.contentState)).toEqual(["stage"]);
  });

  it("does not start a card for a date that has already begun", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    await startDateDayActivities("m1", new Date(DATE_AT.getTime() + 60_000));
    expect(sendLiveActivityStartToUser).not.toHaveBeenCalled();
  });

  it("does nothing when the match has no agreed time", async () => {
    matchFindUnique.mockResolvedValue(matchRow({ agreedTime: null }));
    await startDateDayActivities("m1", NOW);
    expect(sendLiveActivityStartToUser).not.toHaveBeenCalled();
  });

  it("delivers to one side even when the other's push throws", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    sendLiveActivityStartToUser.mockRejectedValueOnce(new Error("apns down"));
    await expect(startDateDayActivities("m1", NOW)).resolves.toBeUndefined();
    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
  });
});

describe("advanceDateDayActivities", () => {
  it("updates both sides and keeps the stale date pinned to the date", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await advanceDateDayActivities("m1", "wingman");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    const [, , payload] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(payload).toEqual({
      event: "update",
      contentState: { stage: "wingman" },
      staleDate: Math.floor(DATE_AT.getTime() / 1000),
    });
  });
});

describe("endDateDayActivities", () => {
  it("ends both sides with no content state", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await endDateDayActivities("m1");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityUpdateToUser.mock.calls[0]![2]).toEqual({ event: "end" });
  });
});
