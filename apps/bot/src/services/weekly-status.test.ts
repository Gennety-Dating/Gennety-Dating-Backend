import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    profile: {
      findUnique: vi.fn(),
    },
    match: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: mockPrisma,
}));

import { resolveWeeklyStatusForUser } from "./weekly-status.js";

describe("resolveWeeklyStatusForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matched when the user has an active in-flight match", async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      standbyCount: 3,
      lastMissedAt: new Date("2026-04-24T18:00:00Z"),
    });
    mockPrisma.match.findFirst.mockResolvedValue({ id: "match-1" });

    const result = await resolveWeeklyStatusForUser(
      "user-1",
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result).toEqual({
      weeklyStatus: "matched",
      standbyCount: 3,
      priorityBoosted: false,
      resolvedAt: null,
    });
  });

  it("returns standby when the user missed the current batch window", async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      standbyCount: 2,
      lastMissedAt: new Date("2026-04-23T18:30:00Z"),
    });
    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-2",
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result.weeklyStatus).toBe("standby");
    expect(result.standbyCount).toBe(2);
    expect(result.priorityBoosted).toBe(true);
    expect(result.resolvedAt).toBe("2026-04-23T18:30:00.000Z");
  });

  it("returns pending when the user has no active match and no current-cycle standby", async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      standbyCount: 0,
      lastMissedAt: null,
    });
    mockPrisma.match.findFirst.mockResolvedValue(null);

    const result = await resolveWeeklyStatusForUser(
      "user-3",
      new Date("2026-04-26T09:00:00Z"),
    );

    expect(result).toEqual({
      weeklyStatus: "pending",
      standbyCount: 0,
      priorityBoosted: false,
      resolvedAt: null,
    });
  });
});
