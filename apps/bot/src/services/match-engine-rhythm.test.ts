import { describe, expect, it } from "vitest";
import type { RhythmTags } from "@gennety/shared";
import {
  RHYTHM_MATCH_WEIGHT,
  composeScore,
  scoreCandidate,
  scorePair,
  type BatchUser,
  type RichCandidateRow,
  type SeekerProfile,
} from "./match-engine.js";

/**
 * `V_rhythm` — the Tempo Sync matching factor (decision journal 2026-09-24).
 * Pure scoring only; the reads are covered by `rhythm-api.test.ts` and the
 * fence by `rhythm/boundary.test.ts`.
 */

const LIVE_WEIGHT = 0.05;

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
};
const candidate: RichCandidateRow = {
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

const tags = (activity: RhythmTags["activity"], chronotype: RhythmTags["chronotype"]): RhythmTags => ({
  activity,
  chronotype,
});

/** `scoreCandidate(seeker, candidate, weights?, typeFloor?, intentFloor?, rhythmWeight?)`. */
const score = (a: RhythmTags | null, b: RhythmTags | null, weight: number) =>
  scoreCandidate({ ...seeker, rhythm: a }, { ...candidate, rhythm: b }, undefined, 1, 1, weight);

describe("scoreCandidate — V_rhythm", () => {
  it("ships at weight 0 unless the env says otherwise", () => {
    expect(RHYTHM_MATCH_WEIGHT).toBe(0);
  });

  it("is inert at weight 0 but still reports the similarity — the shadow log", () => {
    const alike = score(tags("active", "early"), tags("active", "early"), 0);
    const opposite = score(tags("active", "early"), tags("calm", "late"), 0);
    expect(alike.breakdown.rhythm).toBe(1);
    expect(opposite.breakdown.rhythm).toBe(1);
    expect(alike.score).toBeCloseTo(opposite.score, 12);
    expect(alike.breakdown.rhythmSimilarity).toBe(1);
    expect(opposite.breakdown.rhythmSimilarity).toBe(0);
  });

  it("leans by at most ±w once live, around the unchanged neutral score", () => {
    const neutral = score(null, null, LIVE_WEIGHT);
    const alike = score(tags("active", "early"), tags("active", "early"), LIVE_WEIGHT);
    const opposite = score(tags("active", "early"), tags("calm", "late"), LIVE_WEIGHT);
    expect(alike.breakdown.rhythm).toBeCloseTo(1.05, 10);
    expect(opposite.breakdown.rhythm).toBeCloseTo(0.95, 10);
    expect(alike.score).toBeGreaterThan(neutral.score);
    expect(opposite.score).toBeLessThan(neutral.score);
  });

  it("is exactly neutral when either side has no profile — every Telegram-only account", () => {
    const oneSided = score(tags("active", "early"), null, LIVE_WEIGHT);
    expect(oneSided.breakdown.rhythm).toBe(1);
    expect(oneSided.breakdown.rhythmSimilarity).toBeNull();
    expect(oneSided.score).toBeCloseTo(score(null, null, LIVE_WEIGHT).score, 12);
  });

  it("is part of the one composite the audit row is recomposed from", () => {
    const scored = score(tags("moderate", null), tags("active", "late"), LIVE_WEIGHT);
    expect(composeScore(scored.breakdown)).toBeCloseTo(scored.score, 12);
  });
});

describe("scorePair — V_rhythm", () => {
  const user = (id: string, gender: string, preference: string, rhythm: RhythmTags | null): BatchUser => ({
    id,
    age: 25,
    gender,
    major: null,
    preference,
    universityDomain: null,
    height: 175,
    negativeConstraints: null,
    psychologicalSummary: null,
    energyAxis: null,
    orientationAxis: null,
    embeddingLiteral: "[0.1]",
    eloScore: 500,
    standbyCount: 0,
    homeCityKey: "ua:kyiv",
    ageRangeMin: null,
    ageRangeMax: null,
    typePrefTags: null,
    appearanceTags: null,
    relationshipIntents: [],
    rhythm,
  });

  it("carries the pair similarity into the breakdown MatchScoreLog persists", () => {
    const a = user("a", "male", "women", tags("active", "intermediate"));
    const b = user("b", "female", "men", tags("moderate", "intermediate"));
    const { breakdown } = scorePair(a, b, 0.4);
    expect(breakdown.rhythmSimilarity).toBeCloseTo(0.7, 10);
    // Weight 0 at launch: logged, not applied.
    expect(breakdown.rhythm).toBe(1);
  });

  it("is order-independent", () => {
    const a = user("a", "male", "women", tags("calm", "late"));
    const b = user("b", "female", "men", tags("active", "early"));
    expect(scorePair(a, b, 0.3)).toEqual(scorePair(b, a, 0.3));
  });

  it("logs null similarity when one side has no profile", () => {
    const a = user("a", "male", "women", tags("calm", "late"));
    const b = user("b", "female", "men", null);
    expect(scorePair(a, b, 0.3).breakdown.rhythmSimilarity).toBeNull();
  });
});
