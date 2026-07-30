import { describe, expect, it } from "vitest";
import {
  applyVenueDiversity,
  fatigueWeightForAge,
  DEFAULT_DIVERSITY_OPTIONS,
  reputationMultiplier,
  type DiversityCandidate,
  type VenueUsage,
} from "./venue-diversity.js";

const DAY = 24 * 60 * 60 * 1000;

function usage(over: Partial<VenueUsage> = {}): VenueUsage {
  return {
    personal: new Set(),
    fatigue: new Map(),
    sameSlot: new Map(),
    everUsed: new Set(),
    reputation: new Map(),
    ...over,
  };
}

/** Candidates are ranked best-first by the caller, so score descends. */
function cand(id: string, score: number, pairFit = 0.8): DiversityCandidate {
  return { id, score, pairFit };
}

describe("fatigueWeightForAge", () => {
  it("decays by recency and expires past the window", () => {
    expect(fatigueWeightForAge(0)).toBe(1);
    expect(fatigueWeightForAge(3 * DAY)).toBe(0.6);
    expect(fatigueWeightForAge(20 * DAY)).toBe(0.25);
    expect(fatigueWeightForAge(45 * DAY)).toBe(0);
  });
});

describe("applyVenueDiversity — hard exclusions", () => {
  it("never proposes a venue either participant has already been to", () => {
    const ranked = [cand("been-there", 0.9), cand("fresh", 0.7)];
    const out = applyVenueDiversity(ranked, usage({ personal: new Set(["been-there"]) }), "m1");
    expect(out.chosen?.id).toBe("fresh");
  });

  it("excludes a venue already booked by another pair in the same slot", () => {
    const ranked = [cand("taken", 0.9), cand("free", 0.7)];
    const out = applyVenueDiversity(ranked, usage({ sameSlot: new Map([["taken", 1]]) }), "m1");
    expect(out.chosen?.id).toBe("free");
  });

  it("falls back to the excluded list rather than failing to schedule", () => {
    // Only option is a repeat: a repeat venue beats no date at all.
    const ranked = [cand("only", 0.9)];
    const out = applyVenueDiversity(ranked, usage({ personal: new Set(["only"]) }), "m1");
    expect(out.chosen?.id).toBe("only");
  });

  it("returns nothing for an empty candidate list", () => {
    expect(applyVenueDiversity([], usage(), "m1")).toEqual({ chosen: null, reason: "empty", pool: [] });
  });
});

describe("applyVenueDiversity — quality is never traded away (T4)", () => {
  it("keeps a much better venue even when it is fatigued", () => {
    // 0.90 used three times recently vs an unused 0.60.
    const ranked = [cand("great", 0.9), cand("meh", 0.6)];
    const out = applyVenueDiversity(
      ranked,
      usage({ fatigue: new Map([["great", 3]]), everUsed: new Set(["great"]) }),
      "m1",
    );
    expect(out.chosen?.id).toBe("great");
  });

  it("lets fatigue decide only between near-equals", () => {
    const ranked = [cand("tired", 0.82), cand("rested", 0.8)];
    const out = applyVenueDiversity(
      ranked,
      usage({ fatigue: new Map([["tired", 5]]), everUsed: new Set(["tired", "rested"]) }),
      "m1",
    );
    expect(out.chosen?.id).toBe("rested");
  });

  it("the exploration bonus cannot rescue a clearly worse venue", () => {
    const ranked = [cand("proven", 0.9), cand("never-used", 0.6)];
    const out = applyVenueDiversity(ranked, usage({ everUsed: new Set(["proven"]) }), "m1");
    expect(out.chosen?.id).toBe("proven");
  });

  it("the exploration bonus tilts a tie toward the unused venue", () => {
    // Two exact ties: the bonus puts the unused one on top of the rescored
    // pool, and it wins the draw more often. It does NOT win every seed —
    // near-equals go to sampling by design, which is the point of the layer.
    const ranked = [cand("proven", 0.8), cand("never-used", 0.8)];
    const only = usage({ everUsed: new Set(["proven"]) });

    expect(applyVenueDiversity(ranked, only, "m1").pool[0]!.id).toBe("never-used");

    let fresh = 0;
    for (let i = 0; i < 200; i++) {
      if (applyVenueDiversity(ranked, only, `m-${i}`).chosen!.id === "never-used") fresh++;
    }
    expect(fresh).toBeGreaterThan(100);
  });

  it("skips exploration for a candidate below the vibe floor", () => {
    // Unused, but a poor fit — the bonus must not drag it over a good match.
    const ranked = [cand("good-fit", 0.5, 0.8), cand("bad-fit", 0.49, 0.1)];
    const out = applyVenueDiversity(ranked, usage({ everUsed: new Set(["good-fit"]) }), "m1");
    expect(out.chosen?.id).toBe("good-fit");
  });
});

describe("applyVenueDiversity — sampling", () => {
  it("takes the argmax when the field is not close", () => {
    const out = applyVenueDiversity([cand("a", 0.9), cand("b", 0.5)], usage(), "m1");
    expect(out.reason).toBe("argmax-single");
    expect(out.chosen?.id).toBe("a");
  });

  it("does not sample when the best fit is below the vibe floor", () => {
    // Near-equal scores, but nothing here actually suits the pair: shuffling
    // among poor fits would trade quality for nothing.
    const ranked = [cand("a", 0.4, 0.1), cand("b", 0.39, 0.1)];
    const out = applyVenueDiversity(ranked, usage(), "m1");
    expect(out.reason).toBe("argmax-below-floor");
    expect(out.chosen?.id).toBe("a");
  });

  it("is deterministic per match and differs across matches", () => {
    const ranked = [cand("a", 0.8), cand("b", 0.79), cand("c", 0.78)];
    const first = applyVenueDiversity(ranked, usage(), "match-1").chosen?.id;
    expect(applyVenueDiversity(ranked, usage(), "match-1").chosen?.id).toBe(first);

    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      seen.add(applyVenueDiversity(ranked, usage(), `match-${i}`).chosen!.id);
    }
    // The point of the whole layer: across pairs the winner must vary.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("only draws from inside the band", () => {
    const ranked = [cand("a", 0.8), cand("b", 0.79), cand("far", 0.2)];
    for (let i = 0; i < 40; i++) {
      expect(applyVenueDiversity(ranked, usage(), `m-${i}`).chosen!.id).not.toBe("far");
    }
  });

  it("respects a widened band", () => {
    const ranked = [cand("a", 0.8), cand("b", 0.5)];
    const wide = { ...DEFAULT_DIVERSITY_OPTIONS, samplingBand: 0.5 };
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      seen.add(applyVenueDiversity(ranked, usage(), `m-${i}`, wide).chosen!.id);
    }
    expect(seen.size).toBe(2);
  });
});

describe("reputationMultiplier — our own couples' verdicts", () => {
  const opts = { reputationWeight: 0.1, reputationPrior: 3 };

  it("is neutral with no data", () => {
    expect(reputationMultiplier(undefined, opts)).toBe(1);
    expect(reputationMultiplier({ good: 0, bad: 0 }, opts)).toBe(1);
  });

  it("barely moves on a single verdict — the sample is tiny", () => {
    // One bad night must not condemn a venue permanently.
    const one = reputationMultiplier({ good: 0, bad: 1 }, opts);
    expect(one).toBeGreaterThan(0.96);
    expect(one).toBeLessThan(1);
  });

  it("converges toward the bounds as evidence accumulates", () => {
    const loved = reputationMultiplier({ good: 30, bad: 0 }, opts);
    const hated = reputationMultiplier({ good: 0, bad: 30 }, opts);
    expect(loved).toBeGreaterThan(1.08);
    expect(loved).toBeLessThanOrEqual(1.1);
    expect(hated).toBeLessThan(0.92);
    expect(hated).toBeGreaterThanOrEqual(0.9);
  });

  it("is symmetric around neutral", () => {
    expect(reputationMultiplier({ good: 5, bad: 5 }, opts)).toBeCloseTo(1, 10);
  });
});

describe("applyVenueDiversity — reputation", () => {
  it("prefers the venue our couples actually liked, between near-equals", () => {
    const ranked = [cand("liked", 0.8), cand("rejected", 0.8)];
    const out = applyVenueDiversity(
      ranked,
      usage({
        everUsed: new Set(["liked", "rejected"]),
        reputation: new Map([
          ["liked", { good: 12, bad: 0 }],
          ["rejected", { good: 0, bad: 12 }],
        ]),
      }),
      "m1",
    );
    expect(out.pool[0]!.id).toBe("liked");
  });

  it("cannot promote a clearly worse venue on reputation alone (T4)", () => {
    const ranked = [cand("better", 0.9), cand("beloved", 0.6)];
    const out = applyVenueDiversity(
      ranked,
      usage({
        everUsed: new Set(["better", "beloved"]),
        reputation: new Map([
          ["better", { good: 0, bad: 20 }],
          ["beloved", { good: 20, bad: 0 }],
        ]),
      }),
      "m1",
    );
    expect(out.chosen?.id).toBe("better");
  });
});
