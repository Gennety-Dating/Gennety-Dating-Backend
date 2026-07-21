import type { VenueHardConstraints, VenuePriceLimit } from "@gennety/shared";
import type { VenueCategory } from "./vibe-parser.js";
import { MIN_RATING, MIN_RATING_COUNT } from "./venue.js";

export const INITIAL_VENUE_MAX_PRICE: VenuePriceLimit = "moderate";
export const INITIAL_VENUE_ALLOWED_TIER = "base" as const;

export type InitialVenueRejectionReason =
  | "premium_tier"
  | "quality_below_floor"
  | "unknown_price"
  | "too_expensive";

export interface InitialVenuePolicyInput {
  category: VenueCategory;
  tier: string;
  priceLevel: string | null | undefined;
  priceTags?: readonly string[];
  rating: number | null | undefined;
  reviews: number | null | undefined;
}

export type InitialVenuePolicyResult =
  | { eligible: true; price: VenuePriceLimit | null }
  | { eligible: false; reason: InitialVenueRejectionReason };

export function applyInitialVenueConstraintPolicy(hard: VenueHardConstraints): VenueHardConstraints {
  return { ...hard, maxPrice: null };
}

const PRICE_EVIDENCE_REQUIRED = new Set<VenueCategory>([
  "cafe",
  "coffee_shop",
  "restaurant",
  "lounge",
  "museum",
]);

function canonicalPrice(value: string | null | undefined): VenuePriceLimit | "expensive" | null {
  switch (value) {
    case "free":
    case "PRICE_LEVEL_FREE":
      return "free";
    case "inexpensive":
    case "PRICE_LEVEL_INEXPENSIVE":
      return "inexpensive";
    case "moderate":
    case "PRICE_LEVEL_MODERATE":
      return "moderate";
    case "expensive":
    case "very_expensive":
    case "PRICE_LEVEL_EXPENSIVE":
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "expensive";
    default:
      return null;
  }
}

/**
 * Product-owned policy for the automatically assigned first venue.
 *
 * This is deliberately separate from each participant's hard constraints:
 * the pair did not ask for a budget filter. Gennety guarantees a good,
 * base-tier, non-premium first assignment; price/exclusivity choices belong to
 * the post-assignment Venue Change flow.
 */
export function evaluateInitialVenuePolicy(input: InitialVenuePolicyInput): InitialVenuePolicyResult {
  if (input.tier !== INITIAL_VENUE_ALLOWED_TIER) {
    return { eligible: false, reason: "premium_tier" };
  }
  if ((input.rating ?? 0) < MIN_RATING || (input.reviews ?? 0) < MIN_RATING_COUNT) {
    return { eligible: false, reason: "quality_below_floor" };
  }

  // A current provider value outranks an operator tag. This prevents a stale
  // "moderate" tag from hiding a provider-confirmed expensive venue.
  const providerPrice = canonicalPrice(input.priceLevel);
  const taggedPrice = (input.priceTags ?? []).map(canonicalPrice).find((value) => value !== null) ?? null;
  const price = providerPrice ?? taggedPrice;

  if (price === "expensive") return { eligible: false, reason: "too_expensive" };
  if (PRICE_EVIDENCE_REQUIRED.has(input.category) && price === null) {
    return { eligible: false, reason: "unknown_price" };
  }
  return { eligible: true, price };
}
