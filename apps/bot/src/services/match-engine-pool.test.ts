import { describe, it, expect, vi } from "vitest";
import { capPoolPerCity, computePairwiseDistances, type BatchUser } from "./match-engine.js";

/**
 * The pair matrix is quadratic and it lives in the heap of the process that
 * also serves the bot, both Express apps and every cron, on 2 GB and one core.
 */

function user(over: Partial<BatchUser> & { id: string }): BatchUser {
  return {
    age: 25,
    gender: "male",
    major: null,
    preference: "women",
    universityDomain: null,
    height: null,
    negativeConstraints: null,
    psychologicalSummary: null,
    energyAxis: null,
    orientationAxis: null,
    embeddingLiteral: "[0.1,0.2]",
    eloScore: 1000,
    standbyCount: 0,
    homeCityKey: "kyiv",
    ageRangeMin: null,
    ageRangeMax: null,
    ...over,
  } as BatchUser;
}

describe("capPoolPerCity", () => {
  it("leaves a city that fits entirely alone", () => {
    const pool = [user({ id: "a" }), user({ id: "b" })];
    const { kept, cut } = capPoolPerCity(pool, 10);
    expect(kept).toHaveLength(2);
    expect(cut).toHaveLength(0);
  });

  it("takes the people who have waited longest", () => {
    const pool = [
      user({ id: "fresh", standbyCount: 0 }),
      user({ id: "waited-twice", standbyCount: 2 }),
      user({ id: "waited-once", standbyCount: 1 }),
    ];

    const { kept, cut } = capPoolPerCity(pool, 2);

    expect(kept.map((u) => u.id)).toEqual(["waited-twice", "waited-once"]);
    // Nobody is lost: the cut list becomes `missedUserIds`, which increments
    // `standbyCount` — the very field this sort reads — so a cut is a place at
    // the front of next week's queue.
    expect(cut.map((u) => u.id)).toEqual(["fresh"]);
  });

  it("chooses the same people twice over the same data", () => {
    const pool = [
      user({ id: "b", standbyCount: 1 }),
      user({ id: "a", standbyCount: 1 }),
      user({ id: "c", standbyCount: 1 }),
    ];

    // This decides who is in a drop. "Roughly the same" is not good enough.
    const first = capPoolPerCity(pool, 2).kept.map((u) => u.id);
    const second = capPoolPerCity([...pool].reverse(), 2).kept.map((u) => u.id);

    expect(first).toEqual(second);
  });

  it("caps each city on its own", () => {
    const pool = [
      user({ id: "kyiv-1" }),
      user({ id: "kyiv-2" }),
      user({ id: "lviv-1", homeCityKey: "lviv" }),
    ];
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { kept, cut } = capPoolPerCity(pool, 1);

    // One from each city, not one overall.
    expect(kept).toHaveLength(2);
    expect(cut.map((u) => u.id)).toEqual(["kyiv-2"]);
  });
});

describe("computePairwiseDistances", () => {
  it("never builds a pair across cities", async () => {
    // Matching is same-city by construction, so every cross-city pair this
    // loop used to build was built only to be discarded on its first line.
    // With no same-city pair to compute, it must not reach the database.
    const pool = [
      user({ id: "11111111-1111-4111-8111-111111111111", homeCityKey: "kyiv" }),
      user({
        id: "22222222-2222-4222-8222-222222222222",
        homeCityKey: "lviv",
        gender: "female",
        preference: "men",
      }),
    ];

    const distances = await computePairwiseDistances(pool);

    expect(distances.size).toBe(0);
  });

  it("does nothing at all for a pool of one", async () => {
    expect((await computePairwiseDistances([user({ id: "solo" })])).size).toBe(0);
  });
});
