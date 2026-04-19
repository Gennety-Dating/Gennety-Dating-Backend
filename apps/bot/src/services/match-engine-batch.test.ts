import { describe, it, expect } from "vitest";
import {
  greedyPair,
  areMutuallyCompatible,
  scorePair,
  starvationBonus,
  STARVATION_ALPHA,
  STARVATION_CAP,
  type BatchUser,
  type ScoredPair,
} from "./match-engine.js";

// ---------------------------------------------------------------------------
// Helper: minimal BatchUser factory
// ---------------------------------------------------------------------------

function makeBatchUser(overrides: Partial<BatchUser> & { id: string }): BatchUser {
  return {
    age: 22,
    gender: "male",
    major: "Computer Science",
    preference: "women",
    universityDomain: "stanford.edu",
    height: 180,
    negativeConstraints: null,
    visualVector: [0.5, 0.3, 0.8, 0.2, 0.6, 0.4],
    psychologicalSummary: "Extroverted, curious, analytical thinker.",
    embeddingLiteral: null,
    missedWeeks: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// areMutuallyCompatible
// ---------------------------------------------------------------------------

describe("areMutuallyCompatible", () => {
  it("returns true for a compatible M-F pair at the same university", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });
    expect(areMutuallyCompatible(a, b)).toBe(true);
  });

  it("returns true when both prefer 'both'", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "both" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "both" });
    expect(areMutuallyCompatible(a, b)).toBe(true);
  });

  it("returns false for different universities", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women", universityDomain: "stanford.edu" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men", universityDomain: "mit.edu" });
    expect(areMutuallyCompatible(a, b)).toBe(false);
  });

  it("returns false when preferences don't align (one-sided)", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "women" });
    expect(areMutuallyCompatible(a, b)).toBe(false);
  });

  it("returns false when gender is null", () => {
    const a = makeBatchUser({ id: "a", gender: null, preference: "women" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });
    expect(areMutuallyCompatible(a, b)).toBe(false);
  });

  it("returns false when preference is null", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: null });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });
    expect(areMutuallyCompatible(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// greedyPair
// ---------------------------------------------------------------------------

describe("greedyPair", () => {
  it("returns the highest-scoring pair first", () => {
    const pairs: ScoredPair[] = [
      { userAId: "a", userBId: "b", score: 0.5 },
      { userAId: "c", userBId: "d", score: 0.9 },
      { userAId: "e", userBId: "f", score: 0.7 },
    ];
    const result = greedyPair(pairs);
    expect(result[0]!.score).toBe(0.9);
    expect(result[0]!.userAId).toBe("c");
    expect(result[0]!.userBId).toBe("d");
  });

  it("removes paired users from the pool — no user appears twice", () => {
    const pairs: ScoredPair[] = [
      { userAId: "a", userBId: "b", score: 0.9 },
      { userAId: "a", userBId: "c", score: 0.85 },
      { userAId: "b", userBId: "c", score: 0.8 },
      { userAId: "d", userBId: "e", score: 0.7 },
    ];
    const result = greedyPair(pairs);

    // "a" and "b" pair first (score=0.9). Both "a:c" and "b:c" skipped
    // because a and b are taken. "d:e" pairs next.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ userAId: "a", userBId: "b", score: 0.9 });
    expect(result[1]).toEqual({ userAId: "d", userBId: "e", score: 0.7 });
  });

  it("returns empty when no pairs provided", () => {
    expect(greedyPair([])).toEqual([]);
  });

  it("handles a single pair", () => {
    const result = greedyPair([{ userAId: "x", userBId: "y", score: 0.6 }]);
    expect(result).toHaveLength(1);
  });

  it("correctly handles a chain: A-B(0.8), B-C(0.9), C-D(0.7)", () => {
    const pairs: ScoredPair[] = [
      { userAId: "A", userBId: "B", score: 0.8 },
      { userAId: "B", userBId: "C", score: 0.9 },
      { userAId: "C", userBId: "D", score: 0.7 },
    ];
    const result = greedyPair(pairs);

    // B-C has the highest score → paired first. B and C are removed.
    // A-B is skipped (B taken). C-D is skipped (C taken).
    // Only A and D remain but have no pair entry → only 1 match.
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ userAId: "B", userBId: "C", score: 0.9 });
  });

  it("does not mutate the input array", () => {
    const pairs: ScoredPair[] = [
      { userAId: "a", userBId: "b", score: 0.5 },
      { userAId: "c", userBId: "d", score: 0.9 },
    ];
    const original = [...pairs];
    greedyPair(pairs);
    expect(pairs).toEqual(original);
  });

  it("maximises total quality: 6 users, best global allocation", () => {
    // Scenario: 6 users (1-6), multiple cross-scores.
    // Optimal greedy: 1-2 (0.95), then 3-4 (0.88), then 5-6 (0.75).
    const pairs: ScoredPair[] = [
      { userAId: "1", userBId: "2", score: 0.95 },
      { userAId: "1", userBId: "3", score: 0.60 },
      { userAId: "2", userBId: "4", score: 0.55 },
      { userAId: "3", userBId: "4", score: 0.88 },
      { userAId: "5", userBId: "6", score: 0.75 },
      { userAId: "3", userBId: "6", score: 0.70 },
      { userAId: "4", userBId: "5", score: 0.50 },
    ];
    const result = greedyPair(pairs);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ userAId: "1", userBId: "2", score: 0.95 });
    expect(result[1]).toEqual({ userAId: "3", userBId: "4", score: 0.88 });
    expect(result[2]).toEqual({ userAId: "5", userBId: "6", score: 0.75 });
  });
});

// ---------------------------------------------------------------------------
// scorePair — symmetric scoring
// ---------------------------------------------------------------------------

describe("scorePair", () => {
  it("returns a symmetric score (average of both directions)", () => {
    const a = makeBatchUser({
      id: "a",
      gender: "male",
      preference: "women",
      age: 23,
      psychologicalSummary: "Extroverted, creative thinker.",
      visualVector: [0.5, 0.3, 0.8, 0.2, 0.6, 0.4],
    });
    const b = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      age: 22,
      psychologicalSummary: "Ambivert, loves art and jazz.",
      visualVector: [0.6, 0.4, 0.7, 0.3, 0.5, 0.5],
    });

    const score = scorePair(a, b, 0.3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("higher embedding distance produces lower score", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });

    const closeScore = scorePair(a, b, 0.1);
    const farScore = scorePair(a, b, 1.5);

    expect(closeScore).toBeGreaterThan(farScore);
  });

  it("penalty from negative constraints reduces score", () => {
    const a = makeBatchUser({
      id: "a",
      gender: "male",
      preference: "women",
      negativeConstraints: "- [smoker, lazy]",
    });
    const bClean = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      psychologicalSummary: "Energetic runner who loves mornings.",
    });
    const bSmoker = makeBatchUser({
      id: "b2",
      gender: "female",
      preference: "men",
      psychologicalSummary: "Casual smoker who is quite lazy on weekends.",
    });

    const scoreClean = scorePair(a, bClean, 0.3);
    const scoreSmoker = scorePair(a, bSmoker, 0.3);

    expect(scoreClean).toBeGreaterThan(scoreSmoker);
  });
});

// ---------------------------------------------------------------------------
// starvationBonus — capped per-missed-week priority boost
// ---------------------------------------------------------------------------

describe("starvationBonus", () => {
  it("returns 0 for a user who was paired last week (missedWeeks = 0)", () => {
    expect(starvationBonus(0)).toBe(0);
  });

  it("returns 0 for negative or invalid counts (defensive)", () => {
    expect(starvationBonus(-3)).toBe(0);
  });

  it("scales linearly by ALPHA below the cap", () => {
    expect(starvationBonus(1)).toBeCloseTo(STARVATION_ALPHA);
    expect(starvationBonus(3)).toBeCloseTo(STARVATION_ALPHA * 3);
  });

  it("saturates at STARVATION_CAP", () => {
    const largeN = Math.ceil(STARVATION_CAP / STARVATION_ALPHA) + 10;
    expect(starvationBonus(largeN)).toBe(STARVATION_CAP);
  });

  it("cap is strictly below the penalty weight (0.30) so penalties dominate", () => {
    expect(STARVATION_CAP).toBeLessThan(0.30);
  });
});

// ---------------------------------------------------------------------------
// scorePair + starvation — bonus should boost, but not stack
// ---------------------------------------------------------------------------

describe("scorePair with starvation", () => {
  it("a starved user's score is boosted vs. a freshly-matched user", () => {
    const fresh = makeBatchUser({ id: "fresh", gender: "female", preference: "men", missedWeeks: 0 });
    const starved = makeBatchUser({ id: "starved", gender: "female", preference: "men", missedWeeks: 4 });
    const seeker = makeBatchUser({ id: "m", gender: "male", preference: "women", missedWeeks: 0 });

    const baseScore = scorePair(seeker, fresh, 0.3);
    const boostedScore = scorePair(seeker, starved, 0.3);

    expect(boostedScore).toBeGreaterThan(baseScore);
    // The delta is exactly starvationBonus(4) since both pair configs are
    // otherwise identical.
    expect(boostedScore - baseScore).toBeCloseTo(starvationBonus(4));
  });

  it("uses max(a, b) not sum — two starved users don't stack bonuses", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women", missedWeeks: 5 });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men", missedWeeks: 5 });

    const aFresh = makeBatchUser({ id: "a", gender: "male", preference: "women", missedWeeks: 0 });
    const bFresh = makeBatchUser({ id: "b", gender: "female", preference: "men", missedWeeks: 0 });

    const bothStarved = scorePair(a, b, 0.3);
    const neither = scorePair(aFresh, bFresh, 0.3);

    const delta = bothStarved - neither;
    // max-not-sum: the delta equals starvationBonus(5), not 2 * starvationBonus(5).
    expect(delta).toBeCloseTo(starvationBonus(5));
    expect(delta).toBeLessThan(2 * starvationBonus(5));
  });

  it("applied bonus on any pair is bounded by STARVATION_CAP", () => {
    // Hold everything constant except missedWeeks; saturate the bonus.
    const aFresh = makeBatchUser({ id: "a", gender: "male", preference: "women", missedWeeks: 0 });
    const bFresh = makeBatchUser({ id: "b", gender: "female", preference: "men", missedWeeks: 0 });
    const aSaturated = makeBatchUser({ id: "a", gender: "male", preference: "women", missedWeeks: 9999 });

    const baseScore = scorePair(aFresh, bFresh, 0.3);
    const saturatedScore = scorePair(aSaturated, bFresh, 0.3);

    const boost = saturatedScore - baseScore;
    expect(boost).toBeLessThanOrEqual(STARVATION_CAP + 1e-9);
    expect(boost).toBeCloseTo(STARVATION_CAP);
  });
});
