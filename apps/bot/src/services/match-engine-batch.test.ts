import { describe, it, expect } from "vitest";
import { buildPreferenceVector, FEMALE_PHOTOS } from "@gennety/shared";
import {
  greedyPair,
  areMutuallyCompatible,
  scorePair,
  scoreCandidate,
  leagueScore,
  pairLeagueScore,
  starvationBonus,
  LEAGUE_TOLERANCE,
  LEAGUE_FLOOR,
  STARVATION_ALPHA,
  STARVATION_CAP,
  isUuid,
  type BatchUser,
  type ScoredPair,
  type SeekerProfile,
  type RichCandidateRow,
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
    homeCityKey: "ua:kyiv",
    height: 180,
    negativeConstraints: null,
    psychologicalSummary: "Extroverted, curious, analytical thinker.",
    energyAxis: null,
    orientationAxis: null,
    embeddingLiteral: null,
    eloScore: 500,
    standbyCount: 0,
    ageRangeMin: null,
    ageRangeMax: null,
    typePrefTags: null,
    appearanceTags: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// V_type in scoreCandidate
// ---------------------------------------------------------------------------

describe("scoreCandidate — V_type multiplier", () => {
  const pref = buildPreferenceVector(
    "female",
    FEMALE_PHOTOS.map((p) => ({
      photoId: p.id,
      verdict: p.attrs.hairColor === "blonde" ? ("like" as const) : ("dislike" as const),
    })),
  );
  const blondeTags = FEMALE_PHOTOS.find((p) => p.attrs.hairColor === "blonde")!.attrs;
  const redTags = FEMALE_PHOTOS.find((p) => p.attrs.hairColor === "red")!.attrs;

  const seeker: SeekerProfile = {
    age: 26,
    gender: "male",
    height: 180,
    major: null,
    negativeConstraints: null,
    energyAxis: null,
    orientationAxis: null,
    eloScore: 500,
    ageRangeMin: null,
    ageRangeMax: null,
    // Per-set map: the candidates below are female, so the female sub-vector
    // is the one V_type selects (via setForGender).
    typePrefTags: { female: pref },
  };
  const baseCandidate: Omit<RichCandidateRow, "appearanceTags"> = {
    userId: "c",
    telegramId: 0n,
    firstName: null,
    distance: 0.4,
    age: 24,
    gender: "female",
    height: 168,
    major: null,
    psychologicalSummary: null,
    negativeConstraints: null,
    energyAxis: null,
    orientationAxis: null,
    eloScore: 500,
    homeCityKey: "ua:kyiv",
  };

  it("is inert (type=1, score unchanged) at the shadow floor of 1", () => {
    const withType = scoreCandidate(
      seeker,
      { ...baseCandidate, appearanceTags: redTags },
      undefined,
      1,
    );
    const noSignal = scoreCandidate(
      { ...seeker, typePrefTags: null },
      { ...baseCandidate, appearanceTags: redTags },
      undefined,
      1,
    );
    expect(withType.breakdown.type).toBe(1);
    expect(withType.score).toBeCloseTo(noSignal.score, 10);
  });

  it("damps the anti-type below the preferred type when the floor is < 1", () => {
    const blonde = scoreCandidate(
      seeker,
      { ...baseCandidate, appearanceTags: blondeTags },
      undefined,
      0.7,
    );
    const red = scoreCandidate(
      seeker,
      { ...baseCandidate, appearanceTags: redTags },
      undefined,
      0.7,
    );
    expect(blonde.breakdown.type).toBeGreaterThan(red.breakdown.type);
    expect(red.breakdown.type).toBeGreaterThanOrEqual(0.7);
    expect(blonde.breakdown.type).toBeLessThanOrEqual(1);
    // The damped positive bracket makes the anti-type score strictly lower.
    expect(blonde.score).toBeGreaterThan(red.score);
  });

  it("stays neutral (type=1) when the candidate has no appearance tags", () => {
    const scored = scoreCandidate(
      seeker,
      { ...baseCandidate, appearanceTags: null },
      undefined,
      0.7,
    );
    expect(scored.breakdown.type).toBe(1);
  });

  it("does not apply female radar signal to a male candidate (per-set isolation)", () => {
    // Seeker only calibrated the female set; a male candidate has no matching
    // sub-vector, so V_type must stay neutral even at a sub-1 floor.
    const scored = scoreCandidate(
      seeker,
      {
        ...baseCandidate,
        gender: "male",
        appearanceTags: { hairColor: "dark", build: "athletic" },
      },
      undefined,
      0.7,
    );
    expect(scored.breakdown.type).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// areMutuallyCompatible
// ---------------------------------------------------------------------------

describe("areMutuallyCompatible", () => {
  it("returns true for a compatible M-F pair in the same dating city", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });
    expect(areMutuallyCompatible(a, b)).toBe(true);
  });

  it("returns true for different universities in the same dating city", () => {
    const a = makeBatchUser({
      id: "a",
      gender: "male",
      preference: "women",
      universityDomain: "stanford.edu",
      homeCityKey: "ua:kyiv",
    });
    const b = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      universityDomain: "mit.edu",
      homeCityKey: "ua:kyiv",
    });
    expect(areMutuallyCompatible(a, b)).toBe(true);
  });

  it("returns true when both prefer 'both'", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "both" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "both" });
    expect(areMutuallyCompatible(a, b)).toBe(true);
  });

  it("returns false for different dating cities even at the same university", () => {
    const a = makeBatchUser({
      id: "a",
      gender: "male",
      preference: "women",
      universityDomain: "stanford.edu",
      homeCityKey: "ua:kyiv",
    });
    const b = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      universityDomain: "stanford.edu",
      homeCityKey: "ua:lviv",
    });
    expect(areMutuallyCompatible(a, b)).toBe(false);
  });

  it("returns false when either user is missing a dating city", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women", homeCityKey: null });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });
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
    });
    const b = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      age: 22,
      psychologicalSummary: "Ambivert, loves art and jazz.",
    });

    const { score } = scorePair(a, b, 0.3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("higher embedding distance produces lower score", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women" });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men" });

    const { score: closeScore } = scorePair(a, b, 0.1);
    const { score: farScore } = scorePair(a, b, 1.5);

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

    const { score: scoreClean } = scorePair(a, bClean, 0.3);
    const { score: scoreSmoker } = scorePair(a, bSmoker, 0.3);

    expect(scoreClean).toBeGreaterThan(scoreSmoker);
  });
});

// ---------------------------------------------------------------------------
// scorePair — male upward reach flows through the pair path (hetero-only)
// ---------------------------------------------------------------------------

describe("scorePair — V_league male reach", () => {
  // Default MALE_REACH_ELO (36) — env is unset in the unit test runtime.
  const REACH = 36;

  it("forgives the reach allowance when the woman out-scores the man", () => {
    // Woman +120 Elo. Symmetric would be leagueScore(120); the reach discounts
    // 36 Elo before the decay, so the pair path must use the *higher* multiplier.
    const man = makeBatchUser({ id: "m", gender: "male", preference: "women", eloScore: 440 });
    const woman = makeBatchUser({ id: "w", gender: "female", preference: "men", eloScore: 560 });

    const { breakdown } = scorePair(man, woman, 0.3);
    expect(breakdown.league).toBeCloseTo(pairLeagueScore(440, "male", 560, "female", REACH), 10);
    expect(breakdown.league).toBeCloseTo(leagueScore(120 - REACH), 10);
    expect(breakdown.league).toBeGreaterThan(leagueScore(120));
  });

  it("does NOT lift when the man is the more attractive side (matching down)", () => {
    // Man +120 above woman → unchanged symmetric penalty even through the pair.
    const man = makeBatchUser({ id: "m", gender: "male", preference: "women", eloScore: 560 });
    const woman = makeBatchUser({ id: "w", gender: "female", preference: "men", eloScore: 440 });

    const { breakdown } = scorePair(man, woman, 0.3);
    expect(breakdown.league).toBeCloseTo(leagueScore(120), 10);
  });

  it("keeps the symmetric penalty for same-gender pairs (no reach)", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "men", eloScore: 440 });
    const b = makeBatchUser({ id: "b", gender: "male", preference: "men", eloScore: 560 });

    const { breakdown } = scorePair(a, b, 0.3);
    expect(breakdown.league).toBeCloseTo(leagueScore(120), 10);
  });
});

// ---------------------------------------------------------------------------
// scorePair — V_agePref is evaluated symmetrically (each band vs the other age)
// ---------------------------------------------------------------------------

describe("scorePair — V_agePref symmetric evaluation", () => {
  it("averages each side's stated band against the other side's actual age", () => {
    // A (age 30) states a band [20, 22]; B's age 24 is 2 years over →
    // A-direction agePref = 1 - 2 * 0.1 = 0.8. B has no band → B-direction 1.0.
    // The pair breakdown must be the average of both directions = 0.9.
    const a = makeBatchUser({
      id: "a",
      gender: "male",
      preference: "women",
      age: 30,
      ageRangeMin: 20,
      ageRangeMax: 22,
    });
    const b = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      age: 24,
      ageRangeMin: null,
      ageRangeMax: null,
    });

    const { breakdown } = scorePair(a, b, 0.3);
    expect(breakdown.agePref).toBeCloseTo(0.9, 5);
  });

  it("stays neutral (1.0) when neither side set a band", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women", age: 25 });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men", age: 24 });

    const { breakdown } = scorePair(a, b, 0.3);
    expect(breakdown.agePref).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// leagueScore — attractiveness (Elo) is the primary assortative gate
// ---------------------------------------------------------------------------

describe("leagueScore", () => {
  it("is a no-op (1.0) within LEAGUE_TOLERANCE", () => {
    expect(leagueScore(0)).toBe(1.0);
    expect(leagueScore(LEAGUE_TOLERANCE)).toBe(1.0);
    expect(leagueScore(-LEAGUE_TOLERANCE)).toBe(1.0);
  });

  it("is symmetric in the sign of the gap", () => {
    expect(leagueScore(200)).toBeCloseTo(leagueScore(-200), 10);
  });

  it("decays steeply past tolerance (6 Elo per attractiveness point)", () => {
    // ~20 attractiveness-point gap (120 Elo) → 0.70
    expect(leagueScore(120)).toBeCloseTo(0.7, 10);
    // ~30 pts (180 Elo) → 0.40
    expect(leagueScore(180)).toBeCloseTo(0.4, 10);
  });

  it("floors a far-out-of-league pair so it is effectively never matched", () => {
    // "90 vs 30" ≈ 360 Elo gap → clamped at the floor.
    expect(leagueScore(360)).toBe(LEAGUE_FLOOR);
    expect(leagueScore(1000)).toBe(LEAGUE_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// pairLeagueScore — asymmetric male upward reach for hetero pairs
// ---------------------------------------------------------------------------

describe("pairLeagueScore", () => {
  const REACH = 36;

  it("matches leagueScore for same-gender pairs (no reach)", () => {
    expect(pairLeagueScore(500, "male", 700, "male", REACH)).toBe(leagueScore(200));
    expect(pairLeagueScore(700, "female", 500, "female", REACH)).toBe(leagueScore(200));
  });

  it("matches leagueScore when gender is unknown on either side", () => {
    expect(pairLeagueScore(500, null, 700, "female", REACH)).toBe(leagueScore(200));
  });

  it("forgives the reach allowance when the woman is more attractive", () => {
    // Woman +120 Elo above man. Symmetric would be leagueScore(120)=0.70;
    // with a 36-Elo reach the effective gap is 84 → higher multiplier.
    const withReach = pairLeagueScore(440, "male", 560, "female", REACH);
    expect(withReach).toBe(leagueScore(120 - REACH));
    expect(withReach).toBeGreaterThan(leagueScore(120));
  });

  it("is direction-independent (A/B order does not matter)", () => {
    expect(pairLeagueScore(440, "male", 560, "female", REACH)).toBe(
      pairLeagueScore(560, "female", 440, "male", REACH),
    );
  });

  it("lifts a woman up to reach+tolerance above the man to full strength", () => {
    // tolerance 60 + reach 36 = 96 Elo of woman-advantage still scores 1.0.
    expect(pairLeagueScore(500, "male", 596, "female", REACH)).toBe(1.0);
    expect(pairLeagueScore(500, "male", 597, "female", REACH)).toBeLessThan(1.0);
  });

  it("does NOT help when the man is the more attractive one (matching down)", () => {
    // Man +120 above woman — unchanged symmetric penalty.
    expect(pairLeagueScore(560, "male", 440, "female", REACH)).toBe(leagueScore(120));
  });
});

// ---------------------------------------------------------------------------
// scorePair — attractiveness gap dominates over psychology
// ---------------------------------------------------------------------------

describe("scorePair — attractiveness gate", () => {
  it("crushes a far-out-of-league pair even with strong psychology", () => {
    // Same strong embedding distance for both pairs; only Elo differs.
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women", eloScore: 740 });
    const inLeague = makeBatchUser({
      id: "b",
      gender: "female",
      preference: "men",
      eloScore: 740,
    });
    const outOfLeague = makeBatchUser({
      id: "c",
      gender: "female",
      preference: "men",
      eloScore: 380, // ~"30" vs "90" → floored V_league
    });

    const { score: sameLeague } = scorePair(a, inLeague, 0.1);
    const { score: crossLeague } = scorePair(a, outOfLeague, 0.1);

    expect(sameLeague).toBeGreaterThan(crossLeague);
    // The cross-league positive signal is reduced to roughly the floor share.
    expect(crossLeague).toBeLessThan(sameLeague * 0.2);
  });
});

// ---------------------------------------------------------------------------
// starvationBonus — capped per-standby-week priority boost
// ---------------------------------------------------------------------------

describe("starvationBonus", () => {
  it("returns 0 for a user who was paired last week (standbyCount = 0)", () => {
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
    const fresh = makeBatchUser({ id: "fresh", gender: "female", preference: "men", standbyCount: 0 });
    const starved = makeBatchUser({ id: "starved", gender: "female", preference: "men", standbyCount: 4 });
    const seeker = makeBatchUser({ id: "m", gender: "male", preference: "women", standbyCount: 0 });

    const { score: baseScore } = scorePair(seeker, fresh, 0.3);
    const { score: boostedScore } = scorePair(seeker, starved, 0.3);

    expect(boostedScore).toBeGreaterThan(baseScore);
    // The delta is exactly starvationBonus(4) since both pair configs are
    // otherwise identical.
    expect(boostedScore - baseScore).toBeCloseTo(starvationBonus(4));
  });

  it("uses max(a, b) not sum — two starved users don't stack bonuses", () => {
    const a = makeBatchUser({ id: "a", gender: "male", preference: "women", standbyCount: 5 });
    const b = makeBatchUser({ id: "b", gender: "female", preference: "men", standbyCount: 5 });

    const aFresh = makeBatchUser({ id: "a", gender: "male", preference: "women", standbyCount: 0 });
    const bFresh = makeBatchUser({ id: "b", gender: "female", preference: "men", standbyCount: 0 });

    const { score: bothStarved } = scorePair(a, b, 0.3);
    const { score: neither } = scorePair(aFresh, bFresh, 0.3);

    const delta = bothStarved - neither;
    // max-not-sum: the delta equals starvationBonus(5), not 2 * starvationBonus(5).
    expect(delta).toBeCloseTo(starvationBonus(5));
    expect(delta).toBeLessThan(2 * starvationBonus(5));
  });

  it("applied bonus on any pair is bounded by STARVATION_CAP", () => {
    // Hold everything constant except standbyCount; saturate the bonus.
    const aFresh = makeBatchUser({ id: "a", gender: "male", preference: "women", standbyCount: 0 });
    const bFresh = makeBatchUser({ id: "b", gender: "female", preference: "men", standbyCount: 0 });
    const aSaturated = makeBatchUser({ id: "a", gender: "male", preference: "women", standbyCount: 9999 });

    const { score: baseScore } = scorePair(aFresh, bFresh, 0.3);
    const { score: saturatedScore } = scorePair(aSaturated, bFresh, 0.3);

    const boost = saturatedScore - baseScore;
    expect(boost).toBeLessThanOrEqual(STARVATION_CAP + 1e-9);
    expect(boost).toBeCloseTo(STARVATION_CAP);
  });
});

// ---------------------------------------------------------------------------
// isUuid (C-4 SQL-injection defense)
// ---------------------------------------------------------------------------

describe("isUuid (defense-in-depth for raw SQL splicing)", () => {
  it("accepts canonical v4 UUIDs", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });
  it("rejects SQL-injection payloads disguised as ids", () => {
    expect(isUuid("'; DROP TABLE users; --")).toBe(false);
    expect(isUuid("' OR 1=1 --")).toBe(false);
    expect(isUuid("a'+(SELECT '1')+'")).toBe(false);
  });
  it("rejects empty / non-UUID strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("12345")).toBe(false);
    // Wrong version nibble (must be 1-5)
    expect(isUuid("550e8400-e29b-71d4-a716-446655440000")).toBe(false);
    // Wrong variant nibble (must be 8/9/a/b)
    expect(isUuid("550e8400-e29b-41d4-c716-446655440000")).toBe(false);
  });
});
