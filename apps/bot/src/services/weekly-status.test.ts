import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    match: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: mockPrisma,
}));

import { resolveWeeklyStatusForUser } from "./weekly-status.js";
import { getNextBatchDate, getPreviousBatchDate } from "./next-batch.js";

describe("resolveWeeklyStatusForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matched when the user has an active in-flight match", async () => {
    mockPrisma.match.findFirst.mockResolvedValue({ id: "match-1" });

    const result = await resolveWeeklyStatusForUser(
      "user-1",
      { standbyCount: 3, lastMissedAt: new Date("2026-04-24T18:00:00Z") },
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result).toEqual({
      weeklyStatus: "matched",
      standbyCount: 3,
      priorityBoosted: false,
      resolvedAt: null,
    });
    expect(mockPrisma.match.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
        OR: [{ userAId: "user-1" }, { userBId: "user-1" }],
      },
      select: { id: true },
    });
  });

  it("returns standby when the user missed the current batch window", async () => {
    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-2",
      { standbyCount: 2, lastMissedAt: new Date("2026-04-23T18:30:00Z") },
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result.weeklyStatus).toBe("standby");
    expect(result.standbyCount).toBe(2);
    expect(result.priorityBoosted).toBe(true);
    expect(result.resolvedAt).toBe("2026-04-23T18:30:00.000Z");
  });

  it("returns pending when the user has no active match and no current-cycle standby", async () => {
    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-3",
      { standbyCount: 0, lastMissedAt: null },
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result).toEqual({
      weeklyStatus: "pending",
      standbyCount: 0,
      priorityBoosted: false,
      resolvedAt: null,
    });
  });

  it("reads a missing profile as zero standby and no miss", async () => {
    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-4",
      null,
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result).toEqual({
      weeklyStatus: "pending",
      standbyCount: 0,
      priorityBoosted: false,
      resolvedAt: null,
    });
  });

  // Regression coverage for the daily-cadence next-batch.ts rewrite: this
  // function's `priorityBoosted` window is entirely derived from
  // getPreviousBatchDate/getNextBatchDate, so it inherits whatever those two
  // functions compute — these two tests pin the inclusive/exclusive boundary
  // explicitly rather than relying on incidental dates elsewhere in this file.
  it("priorityBoosted is true when lastMissedAt is exactly on the previous-batch boundary (inclusive)", async () => {
    const now = new Date("2026-04-26T09:00:00Z");
    const previousBatchAt = getPreviousBatchDate(now);

    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-boundary-lo",
      { standbyCount: 1, lastMissedAt: previousBatchAt },
      now,
    );
    expect(result.priorityBoosted).toBe(true);
  });

  it("priorityBoosted is false when lastMissedAt is exactly on the next-batch boundary (exclusive)", async () => {
    const now = new Date("2026-04-26T09:00:00Z");
    const nextBatchAt = getNextBatchDate(now);

    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-boundary-hi",
      { standbyCount: 1, lastMissedAt: nextBatchAt },
      now,
    );
    expect(result.priorityBoosted).toBe(false);
  });
});
