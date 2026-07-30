import { describe, expect, it } from "vitest";
import {
  VENUE_INTENT_PARSER_VERSION,
  defaultVenueHardConstraints,
  mapVibeTagsToFacets,
  normalizeVenueIntent,
  rankVenueCandidates,
  resolveVenueBridge,
  type VenueIntentV2,
  type VenueRankCandidate,
} from "./venue-intent.js";

function intent(experiences: VenueIntentV2["experiences"], overrides: Partial<VenueIntentV2> = {}): VenueIntentV2 {
  return {
    rawText: "test",
    experiences,
    ambiences: [],
    formats: [],
    hardConstraints: defaultVenueHardConstraints(),
    parserConfidence: 1,
    parserVersion: VENUE_INTENT_PARSER_VERSION,
    state: "confirmed",
    origin: { lat: 50.45, lng: 30.52, address: null },
    interpretedAt: "2026-01-01T00:00:00.000Z",
    confirmedAt: "2026-01-01T00:00:00.000Z",
    manualConfirmationRequired: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<VenueRankCandidate> = {}): VenueRankCandidate {
  return {
    id: "a",
    placeId: "place-a",
    priority: 2,
    rating: 4.7,
    reviews: 500,
    evidenceConfidence: 1,
    distanceA: 2,
    distanceB: 2.5,
    facets: {
      experiences: ["coffee_treats", "conversation"],
      ambiences: ["quiet"],
      formats: ["seated", "indoor"],
      dietary: [],
      alcoholFree: null,
      stepFree: null,
      setting: "indoor",
      price: "inexpensive",
    },
    ...overrides,
  };
}

describe("Venue Intent V2", () => {
  it.each([
    ["coffee_treats", "walk_view", "coffee_scenic_walk"],
    ["coffee_treats", "art_culture", "gallery_bookstore_cafe"],
    ["meal_discovery", "walk_view", "food_near_promenade"],
    ["drinks_evening", "art_culture", "listening_gallery_bar"],
    ["playful_activity", "meal_discovery", "activity_with_refreshments"],
  ] as const)("bridges %s + %s symmetrically", (left, right, lane) => {
    expect(resolveVenueBridge(intent([left]), intent([right]))).toContain(lane);
    expect(resolveVenueBridge(intent([right]), intent([left]))).toContain(lane);
  });

  it("does not collapse incompatible experiences to cafe", () => {
    expect(resolveVenueBridge(intent(["conversation"]), intent(["meal_discovery"]))).toEqual(["max_min_fit"]);
  });

  it("lets an explicit experience override surprise_me", () => {
    expect(resolveVenueBridge(intent(["surprise_me"]), intent(["art_culture"]))).toEqual(["direct"]);
  });

  it("rejects unknown facets and clamps confidence", () => {
    const normalized = normalizeVenueIntent({
      ...intent(["conversation"]),
      experiences: ["conversation", "not-real" as never],
      parserConfidence: 9,
    });
    expect(normalized.experiences).toEqual(["conversation"]);
    expect(normalized.parserConfidence).toBe(1);
  });

  it("applies hard evidence before ranking", () => {
    const vegan = intent(["coffee_treats"], {
      hardConstraints: { ...defaultVenueHardConstraints(), dietary: ["vegan"] },
    });
    expect(rankVenueCandidates([candidate()], vegan, intent(["conversation"]))).toEqual([]);
    expect(rankVenueCandidates([
      candidate({ facets: { ...candidate().facets, dietary: ["vegan"] } }),
    ], vegan, intent(["conversation"]))).toHaveLength(1);
  });

  it("enforces 8 km worst commute and 3 km imbalance", () => {
    const pair = [intent(["coffee_treats"]), intent(["conversation"])] as const;
    expect(rankVenueCandidates([candidate({ distanceA: 1, distanceB: 8.1 })], ...pair)).toEqual([]);
    expect(rankVenueCandidates([candidate({ distanceA: 1, distanceB: 4.1 })], ...pair)).toEqual([]);
  });

  it("prefers the nearer venue when both commutes are equally balanced", () => {
    // Regression: commuteFairness used to measure ONLY |distA - distB|, so a
    // venue 7.9 km from both scored exactly like one 0.3 km from both and the
    // pair's own coordinates never entered the ranking.
    const pair = [intent(["coffee_treats"]), intent(["coffee_treats"])] as const;
    const near = candidate({ id: "near", placeId: "near", distanceA: 0.3, distanceB: 0.3 });
    const far = candidate({ id: "far", placeId: "far", distanceA: 7.5, distanceB: 7.5 });
    const rows = rankVenueCandidates([far, near], ...pair);
    expect(rows[0]?.candidate.placeId).toBe("near");
    expect(rows[0]!.score.commuteFairness).toBeGreaterThan(rows[1]!.score.commuteFairness);
  });

  it("still penalises an unbalanced commute even when it is close", () => {
    const pair = [intent(["coffee_treats"]), intent(["coffee_treats"])] as const;
    const balanced = candidate({ id: "bal", placeId: "bal", distanceA: 2, distanceB: 2 });
    const lopsided = candidate({ id: "lop", placeId: "lop", distanceA: 0.1, distanceB: 2.9 });
    const rows = rankVenueCandidates([lopsided, balanced], ...pair);
    expect(rows[0]?.candidate.placeId).toBe("bal");
  });

  it("scores facet coverage across the full 0..1 range", () => {
    // `softModifiers` is no longer scored; with it, a perfect match capped at
    // 0.9 and a total miss floored at 0.1, compressing every real difference.
    const wants = intent(["coffee_treats"], { ambiences: ["quiet"], formats: ["seated"] });
    const perfect = candidate({
      facets: {
        experiences: ["coffee_treats"], ambiences: ["quiet"], formats: ["seated"],
        dietary: [], alcoholFree: null, stepFree: null, setting: null, price: "inexpensive",
      },
    });
    const miss = candidate({
      facets: {
        experiences: ["drinks_evening"], ambiences: ["lively"], formats: ["walking"],
        dietary: [], alcoholFree: null, stepFree: null, setting: null, price: "inexpensive",
      },
    });
    const [best] = rankVenueCandidates([perfect], wants, wants);
    const [worst] = rankVenueCandidates([miss], wants, wants);
    expect(best!.score.userFitA).toBe(1);
    expect(worst!.score.userFitA).toBe(0);
  });

  it("ignores softModifiers entirely (reserved, unscored)", () => {
    const pair = [intent(["coffee_treats"]), intent(["coffee_treats"])] as const;
    const plain = candidate({ id: "p", placeId: "p" });
    const decorated = candidate({ id: "d", placeId: "d", softModifiers: ["a", "b", "c"] });
    const [rowPlain] = rankVenueCandidates([plain], ...pair);
    const [rowDecorated] = rankVenueCandidates([decorated], ...pair);
    expect(rowDecorated!.score.finalScore).toBe(rowPlain!.score.finalScore);
  });

  it("uses stable priority, reviews, placeId tie breakers", () => {
    const pair = [intent(["coffee_treats"]), intent(["coffee_treats"])] as const;
    const rows = rankVenueCandidates([
      candidate({ id: "b", placeId: "b", priority: 2, reviews: 100 }),
      candidate({ id: "a", placeId: "a", priority: 1, reviews: 50 }),
    ], ...pair);
    expect(rows[0]?.candidate.placeId).toBe("a");
  });
});

describe("mapVibeTagsToFacets", () => {
  it("translates the operator vocabulary into canonical ids", () => {
    expect(mapVibeTagsToFacets(["coffee", "cozy", "books"])).toEqual({
      experiences: ["coffee_treats", "art_culture"],
      ambiences: ["cozy_public"],
      formats: [],
    });
  });

  it("maps a tag onto several axes at once", () => {
    // `walk` is both an experience and a format; `view` adds a scenic ambience.
    expect(mapVibeTagsToFacets(["walk", "view"])).toEqual({
      experiences: ["walk_view"],
      ambiences: ["scenic"],
      formats: ["walking"],
    });
  });

  it("drops locational and stylistic tags rather than forcing them", () => {
    expect(mapVibeTagsToFacets(["podil", "central", "casual", "upscale", "campus"])).toEqual({
      experiences: [],
      ambiences: [],
      formats: [],
    });
  });

  it("is case- and whitespace-insensitive and dedupes", () => {
    expect(mapVibeTagsToFacets([" Coffee ", "COFFEE", "tea"]).experiences).toEqual(["coffee_treats"]);
  });

  it("returns empty for an empty tag list", () => {
    expect(mapVibeTagsToFacets([])).toEqual({ experiences: [], ambiences: [], formats: [] });
  });
});

describe("facet affinity (partial coverage)", () => {
  const pair = (want: VenueIntentV2["ambiences"]) =>
    [
      intent(["coffee_treats"], { ambiences: want }),
      intent(["coffee_treats"], { ambiences: want }),
    ] as const;

  function withAmbiences(id: string, ambiences: VenueRankCandidate["facets"]["ambiences"]) {
    return candidate({ id, placeId: id, facets: { ...candidate().facets, ambiences } });
  }

  it("gives an adjacent ambience partial credit, below an exact match", () => {
    const exact = withAmbiences("exact", ["quiet"]);
    const adjacent = withAmbiences("adj", ["cozy_public"]);
    const rows = rankVenueCandidates([adjacent, exact], ...pair(["quiet"]));
    expect(rows[0]?.candidate.placeId).toBe("exact");
    expect(rows[1]!.score.userFitA).toBeGreaterThan(0);
    expect(rows[1]!.score.userFitA).toBeLessThan(rows[0]!.score.userFitA);
  });

  it("keeps opposites at zero — a lively room never partly satisfies quiet", () => {
    const opposite = withAmbiences("opp", ["lively"]);
    const [row] = rankVenueCandidates([opposite], ...pair(["quiet"]));
    // Only the experience axis contributes; the ambience axis stays at 0.
    const noAmbience = withAmbiences("none", []);
    const [baseline] = rankVenueCandidates([noAmbience], ...pair(["quiet"]));
    expect(row!.score.userFitA).toBe(baseline!.score.userFitA);
  });

  it("separates venues that previously all tied at zero", () => {
    const adjacent = withAmbiences("adj", ["cozy_public"]);
    const unrelated = withAmbiences("unrel", ["lively"]);
    const rows = rankVenueCandidates([unrelated, adjacent], ...pair(["quiet"]));
    expect(rows[0]?.candidate.placeId).toBe("adj");
  });
});
