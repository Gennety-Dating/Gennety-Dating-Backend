import { describe, expect, it } from "vitest";
import {
  VENUE_CONTEXT_MULTIPLIER_MAX,
  VENUE_CONTEXT_MULTIPLIER_MIN,
  VENUE_INTENT_PARSER_VERSION,
  VENUE_FAIRNESS_DELTA_KM,
  defaultVenueGeoTolerance,
  defaultVenueHardConstraints,
  mapVibeTagsToFacets,
  normalizeVenueIntent,
  rankVenueCandidates,
  resolveVenueBridge,
  seasonalRelevance,
  venueContextMultiplier,
  venueExposureOf,
  weatherRelevanceMultiplier,
  type VenueIntentV2,
  type VenueRankCandidate,
  type VenueWeatherSnapshot,
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

  it("survives tags that collide with Object.prototype members", () => {
    // A plain object literal would resolve these to inherited members, which
    // are truthy — `?? []` would not catch them and the for-of would throw,
    // taking down venue selection for that pair. Operator-authored data, so a
    // venue tagged "constructor" is unlikely but entirely possible.
    expect(() => mapVibeTagsToFacets(["constructor", "__proto__", "toString", "hasOwnProperty"]))
      .not.toThrow();
    expect(mapVibeTagsToFacets(["constructor", "coffee"])).toEqual({
      experiences: ["coffee_treats"],
      ambiences: [],
      formats: [],
    });
  });

  it("ignores non-string entries rather than throwing", () => {
    expect(mapVibeTagsToFacets([null as never, 42 as never, "coffee"]).experiences)
      .toEqual(["coffee_treats"]);
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

// ---------------------------------------------------------------------------
// Season + weather (VENUE_ENGINE_IMPROVEMENT_PLAN 5.3)
// ---------------------------------------------------------------------------

const CLEAR_MILD: VenueWeatherSnapshot = {
  precipitationProbabilityPct: 5,
  temperatureC: 20,
  isSevere: false,
};
const POURING: VenueWeatherSnapshot = {
  precipitationProbabilityPct: 90,
  temperatureC: 12,
  isSevere: false,
};
const FREEZING_STORM: VenueWeatherSnapshot = {
  precipitationProbabilityPct: 95,
  temperatureC: -8,
  isSevere: true,
};

describe("venueExposureOf", () => {
  it("uses the catalog's setting when it has one", () => {
    expect(venueExposureOf("outdoor", "cafe")).toBe("outdoor");
    expect(venueExposureOf("indoor", "park")).toBe("indoor");
    expect(venueExposureOf("both", "cafe")).toBe("mixed");
  });

  it("falls back to category ONLY for parks", () => {
    // A park is outdoor by definition, so an untagged row is still known. A
    // null setting on a restaurant genuinely means unknown — guessing "indoor"
    // there would be inventing evidence the catalog does not have.
    expect(venueExposureOf(null, "park")).toBe("outdoor");
    expect(venueExposureOf(null, "restaurant")).toBe("unknown");
    expect(venueExposureOf(null, null)).toBe("unknown");
  });
});

describe("seasonalRelevance", () => {
  it("never touches indoor or unknown venues", () => {
    for (const month of [1, 4, 7, 10]) {
      expect(seasonalRelevance("indoor", [], month)).toBe(1);
      expect(seasonalRelevance("unknown", ["scenic"], month)).toBe(1);
    }
  });

  it("sinks outdoor venues in winter and lifts them in summer", () => {
    expect(seasonalRelevance("outdoor", [], 1)).toBeLessThan(1);
    expect(seasonalRelevance("outdoor", [], 7)).toBeGreaterThan(1);
  });

  it("treats spring and autumn as neutral", () => {
    // The seasons where the calendar predicts nothing and only the actual
    // forecast is informative.
    for (const month of [3, 4, 5, 9, 10, 11]) {
      expect(seasonalRelevance("outdoor", ["scenic"], month)).toBe(1);
      expect(seasonalRelevance("mixed", [], month)).toBe(1);
    }
  });

  it("penalises a fully outdoor venue harder than a mixed one", () => {
    expect(seasonalRelevance("outdoor", [], 12)).toBeLessThan(seasonalRelevance("mixed", [], 12));
  });

  it("amplifies a scenic outdoor spot in summer", () => {
    expect(seasonalRelevance("outdoor", ["scenic"], 7)).toBeGreaterThan(
      seasonalRelevance("outdoor", [], 7),
    );
  });
});

describe("weatherRelevanceMultiplier", () => {
  it("treats an unknown forecast exactly like perfect weather", () => {
    // The single most important property: a provider outage must never be able
    // to withhold the outdoor half of the catalog.
    expect(weatherRelevanceMultiplier("outdoor", [], null)).toBe(1);
    expect(weatherRelevanceMultiplier("mixed", ["scenic"], null)).toBe(1);
  });

  it("never reads the forecast for indoor or unknown venues", () => {
    expect(weatherRelevanceMultiplier("indoor", [], FREEZING_STORM)).toBe(1);
    expect(weatherRelevanceMultiplier("unknown", [], FREEZING_STORM)).toBe(1);
  });

  it("sinks exposed venues in rain and lifts them in clear mild weather", () => {
    expect(weatherRelevanceMultiplier("outdoor", [], POURING)).toBeLessThan(1);
    expect(weatherRelevanceMultiplier("outdoor", [], CLEAR_MILD)).toBeGreaterThan(1);
  });

  it("stacks severity and temperature", () => {
    expect(weatherRelevanceMultiplier("outdoor", [], FREEZING_STORM)).toBeLessThan(
      weatherRelevanceMultiplier("outdoor", [], POURING),
    );
  });

  it("does not award the pleasant bonus in borderline cold", () => {
    const chilly: VenueWeatherSnapshot = { precipitationProbabilityPct: 0, temperatureC: 7, isSevere: false };
    expect(weatherRelevanceMultiplier("outdoor", [], chilly)).toBe(1);
  });
});

describe("venueContextMultiplier", () => {
  it("stays inside the clamp for every combination", () => {
    const exposures = ["indoor", "outdoor", "mixed", "unknown"] as const;
    const weathers = [null, CLEAR_MILD, POURING, FREEZING_STORM];
    for (const exposure of exposures) {
      for (const weather of weathers) {
        for (const ambiences of [[], ["scenic"]]) {
          for (let month = 1; month <= 12; month += 1) {
            const value = venueContextMultiplier(exposure, ambiences, month, weather);
            expect(value).toBeGreaterThanOrEqual(VENUE_CONTEXT_MULTIPLIER_MIN);
            expect(value).toBeLessThanOrEqual(VENUE_CONTEXT_MULTIPLIER_MAX);
          }
        }
      }
    }
  });

  it("clamps the worst case rather than letting the factors compound", () => {
    // Winter (0.9) x severe (0.85) x freezing (0.9) is ~0.69 unclamped, which
    // is enough to push a genuinely better venue below a worse one — the exact
    // trade the clamp exists to forbid.
    expect(venueContextMultiplier("outdoor", [], 1, FREEZING_STORM)).toBe(VENUE_CONTEXT_MULTIPLIER_MIN);
  });

  it("is exactly neutral for an indoor venue in any conditions", () => {
    // Most of the catalog is indoor, so this is the common path: the feature
    // must be a no-op there rather than a rounding error.
    for (let month = 1; month <= 12; month += 1) {
      expect(venueContextMultiplier("indoor", [], month, FREEZING_STORM)).toBe(1);
    }
  });

  it("cannot reverse a meaningful quality gap", () => {
    // The product guarantee (T4): variety and context never cost quality. A
    // clearly better venue must survive the worst context penalty.
    const strongIndoor = 0.75;
    const weakOutdoor = 0.6;
    const worst = venueContextMultiplier("outdoor", [], 1, FREEZING_STORM);
    const best = venueContextMultiplier("indoor", [], 7, CLEAR_MILD);
    expect(strongIndoor * best).toBeGreaterThan(weakOutdoor * worst);
  });
});

describe("geo tolerance ladder (PRODUCT_SPEC §3.7)", () => {
  const A = intent(["coffee_treats"]);
  const B = intent(["coffee_treats"]);

  it("defaults to the pair's own stated tolerance", () => {
    expect(defaultVenueGeoTolerance(A, B)).toEqual({
      commuteLimitKm: 8,
      fairnessDeltaKm: VENUE_FAIRNESS_DELTA_KM,
    });
  });

  it("rejects a venue past the default commute limit, and accepts it once widened", () => {
    // 10 km from both: too far at rung 1 (8 km), fine at rung 2 (12 km). This
    // is the pair that used to get no date at all.
    const far = candidate({ distanceA: 10, distanceB: 10 });

    expect(rankVenueCandidates([far], A, B)).toHaveLength(0);
    expect(
      rankVenueCandidates([far], A, B, { commuteLimitKm: 12, fairnessDeltaKm: 5 }),
    ).toHaveLength(1);
  });

  it("rejects a lopsided venue on fairness alone, independently of the commute cap", () => {
    // Inside 8 km for both, but 4 km apart — over the 3 km fairness delta.
    const lopsided = candidate({ distanceA: 1, distanceB: 5 });

    expect(rankVenueCandidates([lopsided], A, B)).toHaveLength(0);
    expect(
      rankVenueCandidates([lopsided], A, B, { commuteLimitKm: 12, fairnessDeltaKm: 5 }),
    ).toHaveLength(1);
  });

  it("still prefers the closer, fairer venue at the widest rung", () => {
    // The reason the score scales follow the tolerance: at the widest rung
    // (the market radius, 21 km for Kyiv) a frozen 8 km scale would flatten
    // both of these to the proximity floor and let fit alone decide, which is
    // precisely when commute matters most.
    const citywide = { commuteLimitKm: 21, fairnessDeltaKm: 21 };
    const near = candidate({ id: "near", placeId: "near", distanceA: 3, distanceB: 3 });
    const far = candidate({ id: "far", placeId: "far", distanceA: 18, distanceB: 3 });

    const ranked = rankVenueCandidates([far, near], A, B, citywide);

    expect(ranked.map((row) => row.candidate.id)).toEqual(["near", "far"]);
  });

  it("widening never admits a venue that fails a NON-geographic constraint", () => {
    // The ladder relaxes geometry and nothing else: an outdoor-only pair must
    // not be handed an indoor venue just because the search had to stretch.
    const outdoorOnly = intent(["walk_view"], {
      hardConstraints: { ...defaultVenueHardConstraints(), setting: "outdoor" },
    });
    const indoor = candidate({ distanceA: 10, distanceB: 10 });

    expect(
      rankVenueCandidates([indoor], outdoorOnly, B, { commuteLimitKm: 60, fairnessDeltaKm: 60 }),
    ).toHaveLength(0);
  });
});
