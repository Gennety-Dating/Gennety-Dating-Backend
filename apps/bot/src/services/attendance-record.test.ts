import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}));

import { recordDateAttendance } from "./attendance-record.js";

const MATCH = { status: "completed", userAId: "a", userBId: "b" };

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(MATCH);
  update.mockReset().mockResolvedValue({});
});

describe("recordDateAttendance", () => {
  it("a yes writes only this side's column", async () => {
    await expect(
      recordDateAttendance({ matchId: "m", userId: "b", attended: true }),
    ).resolves.toEqual({ ok: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: "m" }, data: { dateAttendedB: true } });
  });

  it("a no with what happened writes both of this side's columns — the same no-show facts Telegram writes", async () => {
    await recordDateAttendance({ matchId: "m", userId: "a", attended: false, outcome: "no_show_partner" });
    expect(update.mock.calls.map((c) => c[0].data)).toEqual([
      { dateAttendedA: false },
      { attendanceOutcomeA: "no_show_partner" },
    ]);
  });

  it("refuses an outcome with a yes, or an unknown outcome, before reading anything", async () => {
    await expect(
      recordDateAttendance({ matchId: "m", userId: "a", attended: true, outcome: "other" }),
    ).resolves.toEqual({ ok: false, error: "bad-outcome" });
    await expect(
      recordDateAttendance({ matchId: "m", userId: "a", attended: false, outcome: "ghosted" }),
    ).resolves.toEqual({ ok: false, error: "bad-outcome" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("only a participant, only on a completed match", async () => {
    await expect(
      recordDateAttendance({ matchId: "m", userId: "z", attended: true }),
    ).resolves.toEqual({ ok: false, error: "not-participant" });
    findUnique.mockResolvedValue({ ...MATCH, status: "scheduled" });
    await expect(
      recordDateAttendance({ matchId: "m", userId: "a", attended: true }),
    ).resolves.toEqual({ ok: false, error: "wrong-state" });
    findUnique.mockResolvedValue(null);
    await expect(
      recordDateAttendance({ matchId: "m", userId: "a", attended: true }),
    ).resolves.toEqual({ ok: false, error: "match-not-found" });
    expect(update).not.toHaveBeenCalled();
  });
});
