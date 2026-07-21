import { describe, expect, it } from "vitest";
import { defaultVenueHardConstraints } from "@gennety/shared";
import { applyInitialVenueConstraintPolicy, evaluateInitialVenuePolicy } from "./initial-venue-policy.js";

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
    expect(evaluateInitialVenuePolicy(input({ tier: "premium" }))).toEqual({ eligible: false, reason: "premium_tier" });
    expect(evaluateInitialVenuePolicy(input({ priceLevel: "PRICE_LEVEL_EXPENSIVE" }))).toEqual({ eligible: false, reason: "too_expensive" });
  });

  it("rejects unknown commercial and admission prices", () => {
    expect(evaluateInitialVenuePolicy(input({ priceLevel: null }))).toEqual({ eligible: false, reason: "unknown_price" });
    expect(evaluateInitialVenuePolicy(input({ category: "museum", priceLevel: null }))).toEqual({ eligible: false, reason: "unknown_price" });
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
