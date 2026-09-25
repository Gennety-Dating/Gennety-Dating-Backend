import { describe, expect, it } from "vitest";
import {
  RHYTHM_ACTIVITY_LEVELS,
  RHYTHM_CHRONOTYPES,
  RHYTHM_MATCH_WEIGHT_MAX,
  RHYTHM_STALE_AFTER_DAYS,
  isRhythmFresh,
  pairChoseMovement,
  pairLeadActivity,
  parseRhythmUpload,
  rhythmMultiplier,
  rhythmSimilarity,
  rhythmTagsFrom,
  venueTier2Fit,
  venueTier2Multiplier,
  type RhythmTags,
} from "./life-rhythm.js";

/** The weight the founder was shown on 2026-09-24 as the eventual live value. */
const LIVE_WEIGHT = 0.05;

const validBody = {
  algoVersion: 1,
  windowDays: 28,
  coverageDays: 21,
  activity: "active",
  chronotype: "early",
  source: "healthkit",
  consentVersion: "2026-09-25",
};

const tags = (activity: RhythmTags["activity"], chronotype: RhythmTags["chronotype"]): RhythmTags => ({
  activity,
  chronotype,
});

describe("life rhythm — the axes", () => {
  it("keeps position order, since the distance is an index difference", () => {
    expect(RHYTHM_ACTIVITY_LEVELS).toEqual(["calm", "moderate", "active"]);
    expect(RHYTHM_CHRONOTYPES).toEqual(["early", "intermediate", "late"]);
  });
});

describe("parseRhythmUpload", () => {
  it("accepts the exact contract", () => {
    const parsed = parseRhythmUpload(validBody);
    expect(parsed).toEqual({ ok: true, value: validBody });
  });

  it("accepts a null chronotype", () => {
    const parsed = parseRhythmUpload({ ...validBody, chronotype: null });
    expect(parsed.ok && parsed.value.chronotype).toBeNull();
  });

  it("refuses an unknown field instead of dropping it — raw numbers must fail loudly", () => {
    const parsed = parseRhythmUpload({ ...validBody, medianSteps: 11_234 });
    expect(parsed).toEqual({ ok: false, error: "unknown field: medianSteps" });
  });

  it("refuses coverage under the floor and over the window", () => {
    expect(parseRhythmUpload({ ...validBody, coverageDays: 9 }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, coverageDays: 29 }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, coverageDays: 10 }).ok).toBe(true);
    expect(parseRhythmUpload({ ...validBody, coverageDays: 28 }).ok).toBe(true);
  });

  it("does not coerce strings", () => {
    expect(parseRhythmUpload({ ...validBody, coverageDays: "21" }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, algoVersion: "1" }).ok).toBe(false);
  });

  it("refuses unknown enum values, source and consent version", () => {
    expect(parseRhythmUpload({ ...validBody, activity: "athlete" }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, chronotype: "night" }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, source: "coremotion" }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, consentVersion: "2099-01-01" }).ok).toBe(false);
    expect(parseRhythmUpload({ ...validBody, chronotype: undefined }).ok).toBe(false);
  });

  it("refuses non-objects", () => {
    expect(parseRhythmUpload(null).ok).toBe(false);
    expect(parseRhythmUpload([]).ok).toBe(false);
    expect(parseRhythmUpload("active").ok).toBe(false);
  });
});

describe("freshness", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  it("counts a profile up to the stale horizon and not past it", () => {
    const edge = new Date(now.getTime() - RHYTHM_STALE_AFTER_DAYS * 86_400_000);
    expect(isRhythmFresh(edge, now)).toBe(true);
    expect(isRhythmFresh(new Date(edge.getTime() - 1), now)).toBe(false);
  });
});

describe("rhythmTagsFrom", () => {
  it("narrows stored strings and treats anything unknown as absent", () => {
    expect(rhythmTagsFrom("calm", null)).toEqual(tags("calm", null));
    expect(rhythmTagsFrom("active", "late")).toEqual(tags("active", "late"));
    expect(rhythmTagsFrom("hyper", "late")).toBeNull();
    expect(rhythmTagsFrom("calm", "midnight")).toBeNull();
    expect(rhythmTagsFrom(null, null)).toBeNull();
  });
});

describe("rhythmSimilarity", () => {
  it("is null when either side has no profile", () => {
    expect(rhythmSimilarity(tags("active", "early"), null)).toBeNull();
    expect(rhythmSimilarity(undefined, tags("active", "early"))).toBeNull();
  });

  it("is 1 for identical rhythms and 0 for opposite corners", () => {
    expect(rhythmSimilarity(tags("active", "early"), tags("active", "early"))).toBe(1);
    expect(rhythmSimilarity(tags("active", "early"), tags("calm", "late"))).toBe(0);
  });

  it("drops the chronotype term when either chronotype is unknown", () => {
    expect(rhythmSimilarity(tags("active", null), tags("calm", "early"))).toBe(0);
    expect(rhythmSimilarity(tags("active", null), tags("moderate", "late"))).toBe(0.5);
  });

  it("is symmetric", () => {
    for (const a of RHYTHM_ACTIVITY_LEVELS) {
      for (const b of RHYTHM_ACTIVITY_LEVELS) {
        for (const ca of [...RHYTHM_CHRONOTYPES, null]) {
          for (const cb of [...RHYTHM_CHRONOTYPES, null]) {
            expect(rhythmSimilarity(tags(a, ca), tags(b, cb))).toBe(
              rhythmSimilarity(tags(b, cb), tags(a, ca)),
            );
          }
        }
      }
    }
  });
});

describe("rhythmMultiplier", () => {
  // The table the founder was shown on 2026-09-24 — pinned so the maths and
  // the explanation cannot drift apart.
  it("reproduces the founder table at the live weight", () => {
    const m = (a: RhythmTags | null, b: RhythmTags | null) =>
      rhythmMultiplier(rhythmSimilarity(a, b), LIVE_WEIGHT);
    expect(m(tags("active", "early"), tags("active", "early"))).toBeCloseTo(1.05, 10);
    expect(m(tags("active", "intermediate"), tags("moderate", "intermediate"))).toBeCloseTo(1.02, 10);
    expect(m(tags("active", "early"), tags("calm", "late"))).toBeCloseTo(0.95, 10);
    expect(m(tags("active", "early"), null)).toBe(1);
    expect(m(null, null)).toBe(1);
  });

  it("is exactly neutral at weight 0 — the launch value", () => {
    expect(rhythmMultiplier(0, 0)).toBe(1);
    expect(rhythmMultiplier(1, 0)).toBe(1);
  });

  it("is centred: averaged over every pair of profiles it is 1", () => {
    // The whole reason it is not `[floor, 1]`: connecting Apple Health must not
    // be a loss on average against people who did not.
    const all: RhythmTags[] = [];
    for (const a of RHYTHM_ACTIVITY_LEVELS) {
      for (const c of RHYTHM_CHRONOTYPES) all.push(tags(a, c));
    }
    const values = all.flatMap((a) => all.map((b) => rhythmMultiplier(rhythmSimilarity(a, b), LIVE_WEIGHT)));
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(Math.abs(mean - 1)).toBeLessThan(0.01);
  });

  it("clamps the weight to the ceiling and ignores garbage", () => {
    expect(rhythmMultiplier(1, 5)).toBeCloseTo(1 + RHYTHM_MATCH_WEIGHT_MAX, 10);
    expect(rhythmMultiplier(1, -1)).toBe(1);
    expect(rhythmMultiplier(1, Number.NaN)).toBe(1);
    expect(rhythmMultiplier(Number.NaN, LIVE_WEIGHT)).toBe(1);
  });
});

describe("pairLeadActivity", () => {
  it("follows the calmer known side", () => {
    expect(pairLeadActivity(tags("active", null), tags("calm", null))).toBe("calm");
    expect(pairLeadActivity(tags("moderate", null), tags("active", null))).toBe("moderate");
  });
  it("uses the one known side, and is null with none", () => {
    expect(pairLeadActivity(null, tags("active", "late"))).toBe("active");
    expect(pairLeadActivity(null, undefined)).toBeNull();
  });
});

describe("venue Tier 2", () => {
  const venue = (over: Partial<Parameters<typeof venueTier2Fit>[1]> = {}) => ({
    transitWalkM: null,
    pedestrianNearby: null,
    formats: [] as const,
    ...over,
  });

  it("is neutral without a lead, for a moderate lead, and without venue data", () => {
    expect(venueTier2Fit(null, venue({ transitWalkM: 100 }), false)).toBe(0.5);
    expect(venueTier2Fit("moderate", venue({ transitWalkM: 100 }), false)).toBe(0.5);
    expect(venueTier2Fit("calm", venue(), false)).toBe(0.5);
    expect(venueTier2Fit("active", venue(), false)).toBe(0.5);
  });

  it("leans a calm lead toward the transit entrance and a seat", () => {
    expect(venueTier2Fit("calm", venue({ transitWalkM: 300 }), false)).toBe(1);
    expect(venueTier2Fit("calm", venue({ transitWalkM: 1500 }), false)).toBe(0);
    expect(venueTier2Fit("calm", venue({ transitWalkM: 800 }), false)).toBeCloseTo(0.5, 10);
    expect(venueTier2Fit("calm", venue({ formats: ["seated"] }), false)).toBe(1);
    expect(venueTier2Fit("calm", venue({ formats: ["walking"] }), false)).toBe(0);
  });

  it("leans an active lead toward somewhere to walk", () => {
    expect(venueTier2Fit("active", venue({ formats: ["walking"] }), false)).toBe(1);
    expect(venueTier2Fit("active", venue({ pedestrianNearby: true }), false)).toBe(1);
    expect(venueTier2Fit("active", venue({ pedestrianNearby: false }), false)).toBe(0.25);
  });

  it("leaves movement alone once either person chose it", () => {
    expect(venueTier2Fit("active", venue({ formats: ["walking"] }), true)).toBe(0.5);
    expect(venueTier2Fit("calm", venue({ formats: ["walking"] }), true)).toBe(0.5);
    // Access is not a chip anyone can pick, so it still applies.
    expect(venueTier2Fit("calm", venue({ formats: ["walking"], transitWalkM: 200 }), true)).toBe(1);
  });

  it("reads movement from either side's chips", () => {
    const none = { formats: [], experiences: [] };
    expect(pairChoseMovement(none, none)).toBe(false);
    expect(pairChoseMovement({ formats: ["seated"], experiences: [] }, none)).toBe(true);
    expect(pairChoseMovement(none, { formats: [], experiences: ["walk_view"] })).toBe(true);
    expect(pairChoseMovement(null, undefined)).toBe(false);
  });

  it("maps fit onto a positive, centred weight", () => {
    expect(venueTier2Multiplier(0.5, 0.5)).toBe(1);
    expect(venueTier2Multiplier(1, 0.5)).toBe(1.5);
    expect(venueTier2Multiplier(0, 0.5)).toBe(0.5);
    expect(venueTier2Multiplier(0, 5)).toBeCloseTo(0.1, 10);
    expect(venueTier2Multiplier(1, 0)).toBe(1);
  });
});
