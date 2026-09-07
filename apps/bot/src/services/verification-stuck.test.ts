import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const notifyFounderSubsystemHealth = vi.hoisted(() => vi.fn());
vi.mock("@gennety/db", () => ({ prisma: { user: { findMany } } }));
vi.mock("./founder-notify.js", () => ({ notifyFounderSubsystemHealth }));

import { verificationStuckSweep, STUCK_PENDING_REVIEW_DAYS } from "./verification-stuck.js";

const NOW = new Date("2026-09-07T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

beforeEach(() => {
  findMany.mockReset();
  notifyFounderSubsystemHealth.mockReset();
  notifyFounderSubsystemHealth.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("verificationStuckSweep", () => {
  it("says nothing when nobody is stuck", async () => {
    findMany.mockResolvedValue([]);

    expect(await verificationStuckSweep(NOW)).toEqual({ stuck: 0, longestDays: 0 });
    expect(notifyFounderSubsystemHealth).not.toHaveBeenCalled();
  });

  it("summons a human, with the longest wait named", async () => {
    // `pending_review` is not a state a person can leave: neither eligibility
    // scan admits it, the notification carries no button, and the admin view
    // listing them is a pull endpoint nobody polls.
    findMany.mockResolvedValue([
      { id: "u1", updatedAt: daysAgo(30) },
      { id: "u2", updatedAt: daysAgo(9) },
    ]);

    const result = await verificationStuckSweep(NOW);

    expect(result).toEqual({ stuck: 2, longestDays: 30 });
    expect(notifyFounderSubsystemHealth).toHaveBeenCalledWith(
      expect.stringContaining("2 аккаунт"),
      "degraded",
      2,
    );
  });

  it("asks only for accounts past the threshold, oldest first", async () => {
    findMany.mockResolvedValue([]);

    await verificationStuckSweep(NOW);

    const args = findMany.mock.calls[0]![0];
    expect(args.where.verificationStatus).toBe("pending_review");
    expect(args.where.updatedAt.lt).toEqual(daysAgo(STUCK_PENDING_REVIEW_DAYS));
    expect(args.orderBy).toEqual({ updatedAt: "asc" });
  });

  it("does not decide anything about the person", async () => {
    // Flipping them to `rejected` would unlock the retry buttons and also tell
    // someone they failed an identity check our own pipeline could not decide.
    // That judgement belongs to a human; what was missing was the summons.
    findMany.mockResolvedValue([{ id: "u1", updatedAt: daysAgo(40) }]);

    await verificationStuckSweep(NOW);

    // No writer is even reachable from this module.
    expect(Object.keys(findMany.mock.calls[0]![0])).not.toContain("data");
  });
});
