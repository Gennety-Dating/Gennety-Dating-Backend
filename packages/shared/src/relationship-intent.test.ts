import { describe, expect, it } from "vitest";
import {
  INTENT_MAX_DISTANCE,
  RELATIONSHIP_INTENTS,
  intentCompatibilityScore,
  intentMultiplier,
  intentPosition,
  isRelationshipIntent,
  normalizeIntents,
} from "./relationship-intent.js";

/** The launch value of `INTENT_FLOOR` (config default is 1.0 = shadow). */
const LAUNCH_FLOOR = 0.85;

describe("relationship intent — the axis", () => {
  it("is ordered by horizon, with `spark` first and equal", () => {
    // Position is the whole model: the score is a distance along this array.
    // Reordering silently redefines who is "close" to whom, and putting the
    // product's own philosophy last would frame it as the afterthought answer.
    expect(RELATIONSHIP_INTENTS).toEqual(["spark", "open", "falling", "longterm"]);
    expect(INTENT_MAX_DISTANCE).toBe(3);
  });

  it("recognises only its own values", () => {
    expect(isRelationshipIntent("spark")).toBe(true);
    expect(isRelationshipIntent("serious")).toBe(false);
    expect(isRelationshipIntent(null)).toBe(false);
    expect(isRelationshipIntent(2)).toBe(false);
    expect(intentPosition("longterm")).toBe(3);
    expect(intentPosition("nope")).toBeNull();
  });
});

describe("normalizeIntents", () => {
  it("canonicalises by axis order, not by tap order", () => {
    // Two people who chose the same options in a different order must hold
    // byte-identical rows, or the column becomes a tap log and every reader
    // has to sort it again.
    expect(normalizeIntents(["longterm", "spark", "open"])).toEqual([
      "spark",
      "open",
      "longterm",
    ]);
    expect(normalizeIntents(["open", "spark"])).toEqual(
      normalizeIntents(["spark", "open"]),
    );
  });

  it("accepts a bare string, because two rails answer with exactly one", () => {
    // The chat and the native client render single-select chips; one answer is
    // a valid set of size one, which is why neither needs a control of its own.
    expect(normalizeIntents("falling")).toEqual(["falling"]);
  });

  it("drops duplicates and anything that is not on the axis", () => {
    expect(normalizeIntents(["spark", "spark"])).toEqual(["spark"]);
    expect(normalizeIntents(["spark", "serious", 7, null])).toEqual(["spark"]);
    expect(normalizeIntents(undefined)).toEqual([]);
    expect(normalizeIntents([])).toEqual([]);
    expect(normalizeIntents("garbage")).toEqual([]);
  });
});

describe("intentCompatibilityScore", () => {
  it("is 1 when the sets overlap and 0 at opposite ends", () => {
    expect(intentCompatibilityScore(["open"], ["open"])).toBe(1);
    expect(intentCompatibilityScore(["spark", "open"], ["open", "falling"])).toBe(1);
    expect(intentCompatibilityScore(["spark"], ["longterm"])).toBe(0);
  });

  it("reads the SMALLEST gap between the two sets", () => {
    // "spark or open" against "longterm" is one step short of the far end,
    // because `open` is what the two of them are nearest on — not the average
    // of the pair's positions, which would punish breadth.
    expect(intentCompatibilityScore(["spark", "open"], ["longterm"])).toBeCloseTo(
      1 / 3,
      10,
    );
    expect(intentCompatibilityScore(["spark"], ["falling", "longterm"])).toBeCloseTo(
      1 / 3,
      10,
    );
  });

  it("is symmetric across every pair of sets", () => {
    // `scorePair` averages the two one-directional multipliers, so an
    // asymmetric factor would have half its effect averaged away.
    const sets: (readonly (typeof RELATIONSHIP_INTENTS)[number][])[] = [
      ["spark"],
      ["open"],
      ["falling"],
      ["longterm"],
      ["spark", "open"],
      ["open", "falling", "longterm"],
      [...RELATIONSHIP_INTENTS],
    ];
    for (const a of sets) {
      for (const b of sets) {
        expect(intentCompatibilityScore(a, b)).toBeCloseTo(
          intentCompatibilityScore(b, a),
          10,
        );
      }
    }
  });

  it("falls monotonically with distance", () => {
    const scores = RELATIONSHIP_INTENTS.map((to) =>
      intentCompatibilityScore(["spark"], [to]),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    }
  });
});

describe("intentMultiplier", () => {
  it("is exactly neutral when either side has no intent on file", () => {
    // The rule that makes the factor safe to wire everywhere: legacy rows, the
    // iOS rail before it ships this screen, and anyone who registered before
    // the feature must not be damped for an answer nobody asked them for.
    expect(intentMultiplier(null, ["spark"], LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier(["spark"], undefined, LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier(["nonsense"], ["spark"], LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier([], ["spark"], LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier(null, null, LAUNCH_FLOOR)).toBe(1);
  });

  it("treats a bare string like a set of one", () => {
    expect(intentMultiplier("spark", "longterm", LAUNCH_FLOOR)).toBeCloseTo(
      LAUNCH_FLOOR,
      10,
    );
    expect(intentMultiplier("spark", ["spark"], LAUNCH_FLOOR)).toBeCloseTo(1, 10);
  });

  it("is a no-op at the shadow floor, whatever the pair", () => {
    for (const a of RELATIONSHIP_INTENTS) {
      for (const b of RELATIONSHIP_INTENTS) {
        expect(intentMultiplier([a], [b], 1)).toBe(1);
      }
    }
  });

  it("spans floor..1 at the launch floor", () => {
    expect(intentMultiplier(["falling"], ["falling"], LAUNCH_FLOOR)).toBeCloseTo(1, 10);
    expect(intentMultiplier(["spark"], ["open"], LAUNCH_FLOOR)).toBeCloseTo(0.95, 10);
    expect(intentMultiplier(["spark"], ["falling"], LAUNCH_FLOOR)).toBeCloseTo(0.9, 10);
    expect(intentMultiplier(["spark"], ["longterm"], LAUNCH_FLOOR)).toBeCloseTo(
      LAUNCH_FLOOR,
      10,
    );
  });

  it("fires ONLY where both sides are specific and opposed", () => {
    // This is the property multi-select buys, and the reason it needs no cap.
    // A broad answer says "do not filter me on this", so it lands at or beside
    // everyone — within one step of neutral against ANY partner — while the
    // full damping survives exactly for the pair the factor was built for: the
    // person who wants only a bright story and the person who wants only
    // something lasting.
    const broad = ["spark", "open", "falling"] as const;
    const oneStep = LAUNCH_FLOOR + (1 - LAUNCH_FLOOR) * (1 - 1 / INTENT_MAX_DISTANCE);
    for (const other of RELATIONSHIP_INTENTS) {
      expect(intentMultiplier(broad, [other], LAUNCH_FLOOR)).toBeGreaterThanOrEqual(
        oneStep - 1e-10,
      );
    }
    expect(intentMultiplier(["spark"], ["longterm"], LAUNCH_FLOOR)).toBeCloseTo(
      LAUNCH_FLOOR,
      10,
    );
    // And the damping a broad answer can still take is a fraction of the full
    // range — 5% of the bracket against 15%.
    expect(1 - oneStep).toBeLessThan((1 - LAUNCH_FLOOR) / 2);
  });

  it("makes selecting everything identical to not answering", () => {
    // Self-neutralising, which is why there is no "choose at most N" rule: the
    // widest possible answer buys exactly what an absent answer already gets.
    for (const other of RELATIONSHIP_INTENTS) {
      expect(intentMultiplier([...RELATIONSHIP_INTENTS], [other], LAUNCH_FLOOR)).toBe(
        intentMultiplier(null, [other], LAUNCH_FLOOR),
      );
    }
  });

  it("stays the weakest factor in the formula", () => {
    // The founder's constraint, expressed as arithmetic rather than prose:
    // the whole range of V_intent must stay well under V_type's (floor 0.7 →
    // ×1.43), which is itself far under V_league's (floor 0.05 → ×20). If a
    // later tuning pass drops INTENT_FLOOR below the type floor, intent starts
    // competing with appearance and psychology, which is not what it is for.
    const intentRange = 1 / LAUNCH_FLOOR;
    const typeRange = 1 / 0.7;
    expect(intentRange).toBeLessThan(typeRange);
    expect(intentRange).toBeLessThan(1.2);
  });

  it("clamps a nonsense floor instead of inverting the factor", () => {
    expect(intentMultiplier(["spark"], ["longterm"], -3)).toBe(0);
    expect(intentMultiplier(["spark"], ["longterm"], 4)).toBe(1);
  });
});
