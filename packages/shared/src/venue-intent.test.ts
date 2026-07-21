import { describe, expect, it } from "vitest";
import {
  VENUE_INTENT_PARSER_VERSION,
  defaultVenueHardConstraints,
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

  it("uses stable priority, reviews, placeId tie breakers", () => {
    const pair = [intent(["coffee_treats"]), intent(["coffee_treats"])] as const;
    const rows = rankVenueCandidates([
      candidate({ id: "b", placeId: "b", priority: 2, reviews: 100 }),
      candidate({ id: "a", placeId: "a", priority: 1, reviews: 50 }),
    ], ...pair);
    expect(rows[0]?.candidate.placeId).toBe("a");
  });
});
