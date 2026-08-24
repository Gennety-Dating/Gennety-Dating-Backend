import { describe, expect, it } from "vitest";
import {
  INTENT_MAX_DISTANCE,
  RELATIONSHIP_INTENTS,
  intentCompatibilityScore,
  intentMultiplier,
  intentPosition,
  isRelationshipIntent,
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

describe("intentCompatibilityScore", () => {
  it("is 1 for a match and 0 at opposite ends", () => {
    expect(intentCompatibilityScore("open", "open")).toBe(1);
    expect(intentCompatibilityScore("spark", "longterm")).toBe(0);
  });

  it("is symmetric", () => {
    // `scorePair` averages the two one-directional multipliers, so an
    // asymmetric factor would have half its effect averaged away.
    for (const a of RELATIONSHIP_INTENTS) {
      for (const b of RELATIONSHIP_INTENTS) {
        expect(intentCompatibilityScore(a, b)).toBeCloseTo(
          intentCompatibilityScore(b, a),
          10,
        );
      }
    }
  });

  it("falls monotonically with distance", () => {
    const from = "spark" as const;
    const scores = RELATIONSHIP_INTENTS.map((to) => intentCompatibilityScore(from, to));
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
    expect(intentMultiplier(null, "spark", LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier("spark", undefined, LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier("nonsense", "spark", LAUNCH_FLOOR)).toBe(1);
    expect(intentMultiplier(null, null, LAUNCH_FLOOR)).toBe(1);
  });

  it("is a no-op at the shadow floor, whatever the pair", () => {
    for (const a of RELATIONSHIP_INTENTS) {
      for (const b of RELATIONSHIP_INTENTS) {
        expect(intentMultiplier(a, b, 1)).toBe(1);
      }
    }
  });

  it("spans floor..1 at the launch floor", () => {
    expect(intentMultiplier("falling", "falling", LAUNCH_FLOOR)).toBeCloseTo(1, 10);
    expect(intentMultiplier("spark", "open", LAUNCH_FLOOR)).toBeCloseTo(0.95, 10);
    expect(intentMultiplier("spark", "falling", LAUNCH_FLOOR)).toBeCloseTo(0.9, 10);
    expect(intentMultiplier("spark", "longterm", LAUNCH_FLOOR)).toBeCloseTo(
      LAUNCH_FLOOR,
      10,
    );
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
    expect(intentMultiplier("spark", "longterm", -3)).toBe(0);
    expect(intentMultiplier("spark", "longterm", 4)).toBe(1);
  });
});
