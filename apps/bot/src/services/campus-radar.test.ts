import { beforeEach, describe, expect, it, vi } from "vitest";

const userGroupBy = vi.fn();
const userFindMany = vi.fn();
const matchFindFirst = vi.fn();
const previewDropBatch = vi.fn();
const createProposedMatch = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { groupBy: userGroupBy, findMany: userFindMany },
    match: { findFirst: matchFindFirst },
  },
}));

vi.mock("./match-engine.js", () => ({
  previewDropBatch: (...args: unknown[]) => previewDropBatch(...args),
  createProposedMatch: (...args: unknown[]) => createProposedMatch(...args),
}));

const { decideCampusDrop, measureCampusGrowth, runCampusDrop } = await import(
  "./campus-radar.js"
);

const NOW = new Date("2026-09-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function growth(over: Partial<{ domain: string; newlyVerified: number; totalVerified: number }> = {}) {
  return { domain: "kpi.ua", newlyVerified: 10, totalVerified: 40, ...over };
}

function decide(over: Record<string, unknown> = {}) {
  return decideCampusDrop({
    growth: growth(),
    lastDropAt: null,
    // Far enough away that the blackout is not the thing under test.
    nextBatchAt: new Date(NOW.getTime() + 72 * HOUR),
    now: NOW,
    threshold: 6,
    cooldownHours: 168,
    blackoutHours: 6,
    ...(over as object),
  } as Parameters<typeof decideCampusDrop>[0]);
}

beforeEach(() => {
  userGroupBy.mockReset().mockResolvedValue([]);
  userFindMany.mockReset().mockResolvedValue([]);
  matchFindFirst.mockReset().mockResolvedValue(null);
  previewDropBatch.mockReset().mockResolvedValue({
    eligible: 0,
    pairs: 0,
    finalPairs: [],
    missedUserIds: [],
  });
  createProposedMatch.mockReset().mockResolvedValue({ id: "m1" });
});

describe("decideCampusDrop", () => {
  it("drops a campus that grew past the threshold", () => {
    expect(decide()).toEqual({ domain: "kpi.ua" });
  });

  // Two friends signing up together is not a campus push.
  it("holds below the threshold", () => {
    expect(decide({ growth: growth({ newlyVerified: 5 }) })).toEqual({
      domain: "kpi.ua",
      skipped: "below-threshold",
    });
  });

  it("holds inside the cooldown", () => {
    expect(decide({ lastDropAt: new Date(NOW.getTime() - 24 * HOUR) })).toEqual({
      domain: "kpi.ua",
      skipped: "cooling-down",
    });
  });

  it("drops again once the cooldown has passed", () => {
    expect(decide({ lastDropAt: new Date(NOW.getTime() - 200 * HOUR) })).toEqual({
      domain: "kpi.ua",
    });
  });

  // The guard that matters most: a single-cohort run just before the batch can
  // take a candidate the globally-optimal allocation needed. Same protection
  // REMATCH_PRE_BATCH_BLACKOUT_HOURS gives, for the same reason.
  it("stands down when the ordinary drop is imminent", () => {
    expect(decide({ nextBatchAt: new Date(NOW.getTime() + 2 * HOUR) })).toEqual({
      domain: "kpi.ua",
      skipped: "batch-imminent",
    });
  });

  it("treats a zero blackout as disabled rather than as always imminent", () => {
    expect(
      decide({ blackoutHours: 0, nextBatchAt: new Date(NOW.getTime() + 1000) }),
    ).toEqual({ domain: "kpi.ua" });
  });

  // Order matters on the log line: a campus below the threshold is the boring
  // case and must not be reported as if something held it back.
  it("reports the threshold before the cooldown", () => {
    expect(
      decide({
        growth: growth({ newlyVerified: 1 }),
        lastDropAt: new Date(NOW.getTime() - 1 * HOUR),
      }),
    ).toEqual({ domain: "kpi.ua", skipped: "below-threshold" });
  });
});

describe("measureCampusGrowth", () => {
  it("counts new verifications inside the window against the whole cohort", async () => {
    userGroupBy
      .mockResolvedValueOnce([
        { universityDomain: "kpi.ua", _count: { _all: 40 } },
        { universityDomain: "knu.ua", _count: { _all: 12 } },
      ])
      .mockResolvedValueOnce([{ universityDomain: "kpi.ua", _count: { _all: 9 } }]);

    const rows = await measureCampusGrowth(NOW, 48);

    expect(rows).toEqual([
      { domain: "kpi.ua", newlyVerified: 9, totalVerified: 40 },
      { domain: "knu.ua", newlyVerified: 0, totalVerified: 12 },
    ]);
  });

  // A general-track user has no campus; counting them would make the radar
  // measure the product's growth rather than any campus's.
  it("asks only for accounts that have a university domain", async () => {
    await measureCampusGrowth(NOW, 48);

    for (const call of userGroupBy.mock.calls) {
      expect(call[0].where.universityDomain).toEqual({ not: null });
      expect(call[0].where.verificationStatus).toBe("verified");
    }
  });

  it("measures growth over the window it was given", async () => {
    await measureCampusGrowth(NOW, 12);

    const windowed = userGroupBy.mock.calls.find((c) => c[0].where.verifiedAt);
    expect(windowed![0].where.verifiedAt.gte).toEqual(new Date(NOW.getTime() - 12 * HOUR));
  });
});

describe("runCampusDrop", () => {
  // The whole point: one allocator, one definition of a good match. A second
  // pairing implementation would diverge from the first silently.
  it("plans through the ordinary allocator, restricted to the cohort", async () => {
    userFindMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);

    await runCampusDrop("kpi.ua");

    expect(previewDropBatch).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("stamps its pairs as campus, so the cooldown can be read off them", async () => {
    userFindMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    previewDropBatch.mockResolvedValue({
      eligible: 2,
      pairs: 1,
      finalPairs: [
        { userAId: "a", userBId: "b", score: 1, breakdown: {}, allocationFingerprints: {} },
      ],
      missedUserIds: [],
    });

    const result = await runCampusDrop("kpi.ua");

    expect(createProposedMatch).toHaveBeenCalledWith("a", "b", {}, {}, { source: "campus" });
    expect(result).toMatchObject({ domain: "kpi.ua", pairs: 1, matchIds: ["m1"] });
  });

  it("does nothing for a campus that cannot make a pair", async () => {
    userFindMany.mockResolvedValue([{ id: "a" }]);

    const result = await runCampusDrop("kpi.ua");

    expect(previewDropBatch).not.toHaveBeenCalled();
    expect(result).toEqual({ domain: "kpi.ua", eligible: 1, pairs: 0, matchIds: [] });
  });

  // A refused creation (the allocator's own re-check under the row locks) is
  // an ordinary outcome, not an error — it must not be counted as a pair.
  it("counts only the pairs that were actually created", async () => {
    userFindMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    previewDropBatch.mockResolvedValue({
      eligible: 2,
      pairs: 1,
      finalPairs: [
        { userAId: "a", userBId: "b", score: 1, breakdown: {}, allocationFingerprints: {} },
      ],
      missedUserIds: [],
    });
    createProposedMatch.mockResolvedValue(null);

    const result = await runCampusDrop("kpi.ua");

    expect(result.pairs).toBe(0);
    expect(result.matchIds).toEqual([]);
  });
});
