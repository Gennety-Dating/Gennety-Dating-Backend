import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
const matchFindMany = vi.fn();
const matchUpdateMany = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique, findMany: matchFindMany, updateMany: matchUpdateMany },
  },
}));

vi.mock("../config.js", () => ({ env: { MORNING_AFTER_ENABLED: true } }));

const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser }));

const { morningAfterDueAt, isMorningAfterWindow, recordMorningAfter, runMorningAfterTick } =
  await import("./morning-after.js");

const KYIV = "Europe/Kyiv";

describe("morningAfterDueAt", () => {
  it("asks an evening date at 11:00 local the next morning", () => {
    // 19:00 Kyiv (UTC+3 in October) on the 8th → 11:00 Kyiv on the 9th.
    const due = morningAfterDueAt(new Date("2026-10-08T16:00:00Z"), KYIV);
    expect(due.toISOString()).toBe("2026-10-09T08:00:00.000Z");
  });

  it("asks a lunch date the next morning, not an hour later", () => {
    // 12:00 Kyiv → the same day's 11:00 is before the 6 h gap → next day.
    const due = morningAfterDueAt(new Date("2026-10-08T09:00:00Z"), KYIV);
    expect(due.toISOString()).toBe("2026-10-09T08:00:00.000Z");
  });

  it("asks a late-night date the same morning once the gap has passed", () => {
    // 01:00 Kyiv on the 9th → +6 h = 07:00 → 11:00 that day.
    const due = morningAfterDueAt(new Date("2026-10-08T22:00:00Z"), KYIV);
    expect(due.toISOString()).toBe("2026-10-09T08:00:00.000Z");
  });

  it("rolls over a month end and follows the zone's DST", () => {
    // 20:00 Berlin on 31 Oct (CET after the 25 Oct switch, UTC+1).
    const due = morningAfterDueAt(new Date("2026-10-31T19:00:00Z"), "Europe/Berlin");
    expect(due.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });
});

describe("isMorningAfterWindow", () => {
  const agreed = new Date("2026-10-08T16:00:00Z");
  it("is open from 11:00 until the latest hour", () => {
    expect(isMorningAfterWindow(new Date("2026-10-09T07:59:00Z"), agreed, KYIV)).toBe(false);
    expect(isMorningAfterWindow(new Date("2026-10-09T08:00:00Z"), agreed, KYIV)).toBe(true);
    expect(isMorningAfterWindow(new Date("2026-10-09T10:59:00Z"), agreed, KYIV)).toBe(true);
    expect(isMorningAfterWindow(new Date("2026-10-09T11:00:00Z"), agreed, KYIV)).toBe(false);
  });
  it("is never open for a date older than the max age", () => {
    expect(isMorningAfterWindow(new Date("2026-10-10T08:30:00Z"), agreed, KYIV)).toBe(false);
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    userAId: "ua",
    userBId: "ub",
    morningAfterSentAt: new Date("2026-10-09T08:00:00Z"),
    morningAfterA: null,
    morningAfterB: null,
    mutualInterestAt: null,
    ...overrides,
  };
}

describe("recordMorningAfter", () => {
  beforeEach(() => {
    matchFindUnique.mockReset();
    matchUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("refuses a non-participant with not-found (no id probing)", async () => {
    matchFindUnique.mockResolvedValueOnce(row());
    const result = await recordMorningAfter({ matchId: "m1", userId: "stranger", answer: "great" });
    expect(result).toEqual({ ok: false, error: "not-found" });
  });

  it("refuses an answer before the check was sent", async () => {
    matchFindUnique.mockResolvedValueOnce(row({ morningAfterSentAt: null }));
    const result = await recordMorningAfter({ matchId: "m1", userId: "ua", answer: "great" });
    expect(result).toEqual({ ok: false, error: "not-asked" });
  });

  it("a first great is not mutual and reveals nothing", async () => {
    matchFindUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce({ morningAfterA: "great", morningAfterB: null, mutualInterestAt: null });
    const result = await recordMorningAfter({ matchId: "m1", userId: "ua", answer: "great" });
    expect(result).toEqual({ ok: true, answer: "great", mutual: false, mutualJustNow: false });
  });

  it("the second great stamps mutual exactly once", async () => {
    matchFindUnique
      .mockResolvedValueOnce(row({ morningAfterA: "great" }))
      .mockResolvedValueOnce({ morningAfterA: "great", morningAfterB: "great", mutualInterestAt: null });
    matchUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const result = await recordMorningAfter({ matchId: "m1", userId: "ub", answer: "great" });
    expect(result).toEqual({ ok: true, answer: "great", mutual: true, mutualJustNow: true });
    expect(matchUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "m1", mutualInterestAt: null },
      data: { mutualInterestAt: expect.any(Date) },
    });
  });

  it("a pass after a great is never mutual, and the pass side learns nothing", async () => {
    matchFindUnique.mockResolvedValueOnce(row({ morningAfterA: "great" }));
    const result = await recordMorningAfter({ matchId: "m1", userId: "ub", answer: "pass" });
    expect(result).toEqual({ ok: true, answer: "pass", mutual: false, mutualJustNow: false });
  });

  it("the same answer twice is idempotent; a change of mind is refused", async () => {
    matchFindUnique.mockResolvedValueOnce(row({ morningAfterA: "great" }));
    expect(await recordMorningAfter({ matchId: "m1", userId: "ua", answer: "great" })).toMatchObject({
      ok: true,
      mutualJustNow: false,
    });
    matchFindUnique.mockResolvedValueOnce(row({ morningAfterA: "great" }));
    expect(await recordMorningAfter({ matchId: "m1", userId: "ua", answer: "pass" })).toEqual({
      ok: false,
      error: "already-answered",
    });
  });

  it("rejects anything but great / pass", async () => {
    expect(await recordMorningAfter({ matchId: "m1", userId: "ua", answer: "maybe" })).toEqual({
      ok: false,
      error: "bad-answer",
    });
  });
});

describe("runMorningAfterTick", () => {
  const user = (id: string) => ({
    id,
    telegramId: 0n,
    platform: "mobile",
    language: "ru",
    firstName: id === "ua" ? "Анна" : "Олег",
    gender: id === "ua" ? "female" : "male",
    profile: { timeZone: KYIV },
  });

  beforeEach(() => {
    matchFindMany.mockReset();
    matchUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    sendPushToUser.mockReset().mockResolvedValue(true);
  });

  it("pushes both sides without naming anyone, once", async () => {
    matchFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        agreedTime: new Date("2026-10-08T16:00:00Z"),
        dateAttendedA: null,
        dateAttendedB: null,
        userA: user("ua"),
        userB: user("ub"),
      },
    ]);
    const sent = await runMorningAfterTick(null, new Date("2026-10-09T08:05:00Z"));
    expect(sent).toBe(1);
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    for (const call of sendPushToUser.mock.calls) {
      const payload = call[1] as { title: string; body: string; data: { type: string } };
      expect(payload.data.type).toBe("date.morning_after");
      expect(`${payload.title} ${payload.body}`).not.toMatch(/Анна|Олег/u);
    }
  });

  it("skips a pair where someone said the date did not happen", async () => {
    matchFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        agreedTime: new Date("2026-10-08T16:00:00Z"),
        dateAttendedA: false,
        dateAttendedB: null,
        userA: user("ua"),
        userB: user("ub"),
      },
    ]);
    expect(await runMorningAfterTick(null, new Date("2026-10-09T08:05:00Z"))).toBe(0);
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });

  it("does nothing outside the window", async () => {
    matchFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        agreedTime: new Date("2026-10-08T16:00:00Z"),
        dateAttendedA: null,
        dateAttendedB: null,
        userA: user("ua"),
        userB: user("ub"),
      },
    ]);
    expect(await runMorningAfterTick(null, new Date("2026-10-09T06:00:00Z"))).toBe(0);
  });
});
