import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
const matchEventFindFirst = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    matchEvent: { findFirst: matchEventFindFirst },
  },
}));

const createMatchEvent = vi.fn();
vi.mock("./match-events.js", () => ({ createMatchEvent }));

const endDateDayActivityAfterVibe = vi.fn();
vi.mock("./date-day-activity.js", () => ({ endDateDayActivityAfterVibe }));

const { recordDateVibe, isDateVibeRating } = await import("./date-vibe.js");

const AGREED = new Date("2026-09-01T18:00:00.000Z");
const AFTER = new Date("2026-09-01T20:00:00.000Z");

function matchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    userAId: "ua",
    userBId: "ub",
    agreedTime: AGREED,
    status: "scheduled",
    ...overrides,
  };
}

beforeEach(() => {
  matchFindUnique.mockReset().mockResolvedValue(matchRow());
  matchEventFindFirst.mockReset().mockResolvedValue(null);
  createMatchEvent.mockReset().mockResolvedValue(undefined);
  endDateDayActivityAfterVibe.mockReset().mockResolvedValue(undefined);
});

describe("isDateVibeRating", () => {
  it("accepts the three values and nothing else", () => {
    expect(isDateVibeRating("chemistry_great")).toBe(true);
    expect(isDateVibeRating("nice_chat")).toBe(true);
    expect(isDateVibeRating("no_vibe")).toBe(true);
    expect(isDateVibeRating("great")).toBe(false);
    expect(isDateVibeRating(9)).toBe(false);
    // Prototype keys must not sneak through an `in` check.
    expect(isDateVibeRating("toString")).toBe(false);
  });
});

describe("recordDateVibe", () => {
  it("writes the audit row on the positive side with the exact rating kept", async () => {
    const result = await recordDateVibe({
      matchId: "m1",
      userId: "ua",
      rating: "chemistry_great",
      now: AFTER,
    });

    expect(result).toEqual({ ok: true });
    expect(createMatchEvent).toHaveBeenCalledWith({
      matchId: "m1",
      actorId: "ua",
      targetId: "ub",
      actionType: "CHEMISTRY_POSITIVE",
      metadata: { source: "live_activity", rating: "chemistry_great" },
    });
  });

  it("keeps 'warm' on the positive side, with the distinction only in metadata", async () => {
    // The enum is two-valued and cannot gain a third without a migration, so
    // the three-way answer survives in `metadata`. Collapsing "nice_chat" into
    // the negative case would make every pleasant evening read as a failure.
    await recordDateVibe({ matchId: "m1", userId: "ua", rating: "nice_chat", now: AFTER });
    const [call] = createMatchEvent.mock.calls;
    expect(call![0].actionType).toBe("CHEMISTRY_POSITIVE");
    expect(call![0].metadata.rating).toBe("nice_chat");
  });

  it("writes the negative side for no_vibe", async () => {
    await recordDateVibe({ matchId: "m1", userId: "ub", rating: "no_vibe", now: AFTER });
    expect(createMatchEvent.mock.calls[0]![0]).toMatchObject({
      actorId: "ub",
      targetId: "ua",
      actionType: "CHEMISTRY_NEGATIVE",
    });
  });

  it("takes only the answering side's card down", async () => {
    await recordDateVibe({ matchId: "m1", userId: "ua", rating: "no_vibe", now: AFTER });
    expect(endDateDayActivityAfterVibe).toHaveBeenCalledTimes(1);
    expect(endDateDayActivityAfterVibe).toHaveBeenCalledWith("ua", "no_vibe", AFTER);
  });

  it("succeeds without writing twice when the answer is already on record", async () => {
    matchEventFindFirst.mockResolvedValue({ id: "ev1" });

    const result = await recordDateVibe({
      matchId: "m1",
      userId: "ua",
      rating: "nice_chat",
      now: AFTER,
    });

    // A second tap is almost always a retry of a request whose response was
    // lost; a 409 there would put an error on a lock screen for a user who did
    // nothing wrong. But the audit log is append-only, so two rows would count
    // twice.
    expect(result).toEqual({ ok: true });
    expect(createMatchEvent).not.toHaveBeenCalled();
    expect(endDateDayActivityAfterVibe).toHaveBeenCalledTimes(1);
  });

  it("refuses a value this build does not know rather than coercing it", async () => {
    const result = await recordDateVibe({ matchId: "m1", userId: "ua", rating: "meh" });
    expect(result).toEqual({ ok: false, error: "bad-rating" });
    expect(createMatchEvent).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-participant so match ids cannot be probed", async () => {
    const result = await recordDateVibe({
      matchId: "m1",
      userId: "stranger",
      rating: "no_vibe",
      now: AFTER,
    });
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(createMatchEvent).not.toHaveBeenCalled();
  });

  it("refuses an answer about an evening that has not happened", async () => {
    const before = new Date(AGREED.getTime() - 60_000);
    const result = await recordDateVibe({
      matchId: "m1",
      userId: "ua",
      rating: "chemistry_great",
      now: before,
    });
    expect(result).toEqual({ ok: false, error: "wrong-state" });
    expect(createMatchEvent).not.toHaveBeenCalled();
  });

  it("keeps the answer even when the card cannot be taken down", async () => {
    // The answer is the product; the push is housekeeping. A dead token must
    // not lose a tap that already happened.
    endDateDayActivityAfterVibe.mockRejectedValue(new Error("apns down"));

    const result = await recordDateVibe({
      matchId: "m1",
      userId: "ua",
      rating: "chemistry_great",
      now: AFTER,
    });

    expect(result).toEqual({ ok: true });
    expect(createMatchEvent).toHaveBeenCalledTimes(1);
  });
});
