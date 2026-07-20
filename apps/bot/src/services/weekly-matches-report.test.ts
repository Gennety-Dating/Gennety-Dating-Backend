import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_PHOTOS } from "@gennety/shared";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@gennety/db", () => ({
  prisma: { match: { findMany } },
}));

import { buildWeeklyMatchesReport } from "./weekly-matches-report.js";

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    firstName: "Alice",
    age: 22,
    gender: "female",
    verificationStatus: "verified",
    profile: {
      homeCity: "Kyiv",
      photos: Array.from({ length: MAX_PHOTOS + 1 }, (_, index) => `f${index + 1}`),
      eloSeedDetails: { score: 74.6 },
    },
    ...over,
  };
}

describe("buildWeeklyMatchesReport", () => {
  beforeEach(() => findMany.mockReset());

  it("maps a pair into two user cards with attractiveness + capped photos", async () => {
    findMany.mockResolvedValue([
      {
        id: "m1",
        status: "scheduled",
        synergyScore: 88,
        synergyReason: "shared vibe",
        createdAt: new Date("2026-07-15T18:00:00Z"),
        userA: userRow(),
        userB: userRow({
          id: "u2",
          firstName: "Bob",
          gender: "male",
          profile: { homeCity: "Kyiv", photos: ["g1"], eloSeedDetails: null },
        }),
      },
    ]);

    const report = await buildWeeklyMatchesReport({ matchIds: ["m1"] });
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0]!;
    expect(pair.matchId).toBe("m1");
    expect(pair.status).toBe("scheduled");
    expect(pair.synergyScore).toBe(88);

    const [a, b] = pair.users;
    // eloSeedDetails.score rounds to an integer 0..100.
    expect(a.attractiveness).toBe(75);
    expect(a.city).toBe("Kyiv");
    // Reports preserve the full profile allowance and discard legacy overflow.
    expect(a.photoRefs).toHaveLength(MAX_PHOTOS);
    // No vision seed → null score, single photo preserved.
    expect(b.attractiveness).toBeNull();
    expect(b.photoRefs).toEqual(["g1"]);
  });

  it("queries by id set when matchIds are provided", async () => {
    findMany.mockResolvedValue([]);
    await buildWeeklyMatchesReport({ matchIds: ["x", "y"] });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["x", "y"] } } }),
    );
  });

  it("queries by a created-at window when no ids are given", async () => {
    findMany.mockResolvedValue([]);
    const since = new Date("2026-07-10T00:00:00Z");
    const until = new Date("2026-07-17T00:00:00Z");
    await buildWeeklyMatchesReport({ since, until });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdAt: { gte: since, lt: until } } }),
    );
  });
});
