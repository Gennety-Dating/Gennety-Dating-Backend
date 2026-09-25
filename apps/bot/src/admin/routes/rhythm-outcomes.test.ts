import { describe, expect, it } from "vitest";
import { MIN_CELL, rhythmBucket, summarizeRhythmOutcomes, type RhythmOutcomeRow } from "./rhythm-outcomes.js";

function rows(n: number, over: Partial<RhythmOutcomeRow>): RhythmOutcomeRow[] {
  return Array.from({ length: n }, () => ({
    rhythmSimilarity: null,
    acceptedByA: false,
    acceptedByB: false,
    status: "expired",
    ...over,
  }));
}

describe("rhythmBucket", () => {
  it("puts a missing side in its own bucket and splits the rest", () => {
    expect(rhythmBucket(null)).toBe("none");
    expect(rhythmBucket(0)).toBe("low");
    expect(rhythmBucket(0.39)).toBe("low");
    expect(rhythmBucket(0.4)).toBe("mid");
    expect(rhythmBucket(0.75)).toBe("high");
    expect(rhythmBucket(1)).toBe("high");
  });
});

describe("summarizeRhythmOutcomes", () => {
  it("publishes rates only for cells of at least MIN_CELL pairs", () => {
    const data = [
      ...rows(MIN_CELL, { rhythmSimilarity: 1, acceptedByA: true, acceptedByB: true }),
      ...rows(MIN_CELL - 1, { rhythmSimilarity: 0.1, acceptedByA: true, acceptedByB: true, status: "completed" }),
    ];
    const out = summarizeRhythmOutcomes(data);
    expect(out.high).toEqual({ pairs: MIN_CELL, mutualAcceptRate: 1, completedRate: 0 });
    // One short of the floor: the count itself is hidden, not just the rates.
    expect(out.low).toEqual({ pairs: `<${MIN_CELL}`, mutualAcceptRate: null, completedRate: null });
    expect(out.none.pairs).toBe(`<${MIN_CELL}`);
  });

  it("counts a mutual yes only when both sides said yes", () => {
    const data = [
      ...rows(10, { rhythmSimilarity: 0.5, acceptedByA: true, acceptedByB: true, status: "completed" }),
      ...rows(10, { rhythmSimilarity: 0.5, acceptedByA: true, acceptedByB: false }),
    ];
    expect(summarizeRhythmOutcomes(data).mid).toEqual({
      pairs: 20,
      mutualAcceptRate: 0.5,
      completedRate: 0.5,
    });
  });

  it("carries no identifiers — only the four buckets", () => {
    const out = summarizeRhythmOutcomes(rows(25, {}));
    expect(Object.keys(out)).toEqual(["none", "low", "mid", "high"]);
    expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
