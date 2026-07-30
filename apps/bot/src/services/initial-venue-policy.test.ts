import { describe, expect, it } from "vitest";
import { defaultVenueHardConstraints } from "@gennety/shared";
import {
  applyInitialVenueConstraintPolicy,
  evaluateInitialVenuePolicy,
  meetsVenueQualityFloor,
} from "./initial-venue-policy.js";

function input(overrides: Partial<Parameters<typeof evaluateInitialVenuePolicy>[0]> = {}) {
  return {
    category: "cafe" as const,
    tier: "base",
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.6,
    reviews: 300,
    ...overrides,
  };
}

describe("initial venue policy", () => {
  it("removes a legacy user price constraint from the initial assignment", () => {
    expect(applyInitialVenueConstraintPolicy({ ...defaultVenueHardConstraints(), maxPrice: "free" }).maxPrice).toBeNull();
  });

  it.each(["PRICE_LEVEL_FREE", "PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"])(
    "accepts the base price band %s",
    (priceLevel) => {
      expect(evaluateInitialVenuePolicy(input({ priceLevel }))).toEqual({
        eligible: true,
        price: priceLevel === "PRICE_LEVEL_FREE" ? "free" : priceLevel === "PRICE_LEVEL_INEXPENSIVE" ? "inexpensive" : "moderate",
      });
    },
  );

  it("rejects premium and expensive candidates before ranking", () => {
    expect(evaluateInitialVenuePolicy(input({ tier: "premium" }))).toEqual({ eligible: false, reason: "non_base_tier" });
    // `alternative` is the operator's heavier-cuisine pool: a fine venue, but
    // never one Gennety picks FOR a pair — it only exists in the change board.
    expect(evaluateInitialVenuePolicy(input({ tier: "alternative" }))).toEqual({ eligible: false, reason: "non_base_tier" });
    expect(evaluateInitialVenuePolicy(input({ priceLevel: "PRICE_LEVEL_EXPENSIVE" }))).toEqual({ eligible: false, reason: "too_expensive" });
  });

  it("rejects an unknown commercial price", () => {
    expect(evaluateInitialVenuePolicy(input({ priceLevel: null }))).toEqual({ eligible: false, reason: "unknown_price" });
  });

  it("admits a museum with no price, because Google never reports one", () => {
    // Measured: 0 of 43 museum rows in the curated catalog carry a priceLevel,
    // so requiring evidence rejected every museum that has ever existed and
    // made the art_culture experience unreachable.
    expect(evaluateInitialVenuePolicy(input({ category: "museum", priceLevel: null }))).toEqual({
      eligible: true,
      price: null,
    });
  });

  it("still refuses a museum whose price IS known to be premium", () => {
    // The protection the evidence rule was meant to give survives: the
    // expensive check runs before it.
    expect(evaluateInitialVenuePolicy(input({ category: "museum", priceLevel: "PRICE_LEVEL_EXPENSIVE" }))).toEqual({
      eligible: false,
      reason: "too_expensive",
    });
  });

  it("accepts an operator-confirmed canonical price when Places has none", () => {
    expect(evaluateInitialVenuePolicy(input({ priceLevel: null, priceTags: ["quiet", "inexpensive"] }))).toEqual({
      eligible: true,
      price: "inexpensive",
    });
  });

  it("does not let a stale operator tag override an expensive provider value", () => {
    expect(evaluateInitialVenuePolicy(input({ priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE", priceTags: ["moderate"] }))).toEqual({
      eligible: false,
      reason: "too_expensive",
    });
  });

  it("allows a public park without a commercial price level", () => {
    expect(evaluateInitialVenuePolicy(input({ category: "park", priceLevel: null }))).toEqual({ eligible: true, price: null });
  });

  it("enforces the same quality floor for curated candidates", () => {
    expect(evaluateInitialVenuePolicy(input({ rating: 3.9 }))).toEqual({ eligible: false, reason: "quality_below_floor" });
    expect(evaluateInitialVenuePolicy(input({ reviews: 29 }))).toEqual({ eligible: false, reason: "quality_below_floor" });
  });
});

describe("quality floor — public space vs commercial venue", () => {
  it("holds commercial venues to the full 4.0 / 30-review bar", () => {
    expect(meetsVenueQualityFloor("cafe", 4.6, 300)).toBe(true);
    expect(meetsVenueQualityFloor("cafe", 4.6, 12)).toBe(false);
    expect(meetsVenueQualityFloor("cafe", 3.8, 300)).toBe(false);
  });

  it("lets a small park through on few reviews", () => {
    // A well-rated viewpoint with 12 reviews is exactly the inventory the
    // commercial review bar was silently deleting.
    expect(meetsVenueQualityFloor("park", 4.6, 12)).toBe(true);
    expect(meetsVenueQualityFloor("park", 4.6, 3)).toBe(false);
  });

  it("still refuses a badly-rated park", () => {
    expect(meetsVenueQualityFloor("park", 3.8, 400)).toBe(false);
  });

  it("admits a park the provider has no data for at all", () => {
    // Маріїнський парк / Оболонська набережна carry no Google rating; that is
    // an absence of data, not a quality signal, and the row is operator-curated.
    expect(meetsVenueQualityFloor("park", null, null)).toBe(true);
  });

  it("does not extend the no-data exemption to commercial venues", () => {
    expect(meetsVenueQualityFloor("cafe", null, null)).toBe(false);
  });

  it("treats an unknown category as commercial (fail closed)", () => {
    expect(meetsVenueQualityFloor("something-new", null, null)).toBe(false);
  });
});

describe("initial venue policy — park quality", () => {
  it("admits an unrated park end to end", () => {
    expect(
      evaluateInitialVenuePolicy({ category: "park", tier: "base", priceLevel: null, rating: null, reviews: null }),
    ).toEqual({ eligible: true, price: null });
  });

  it("still rejects a badly-rated park end to end", () => {
    expect(
      evaluateInitialVenuePolicy({ category: "park", tier: "base", priceLevel: null, rating: 3.8, reviews: 40 }),
    ).toEqual({ eligible: false, reason: "quality_below_floor" });
  });
});
