import type { VenueHardConstraints, VenuePriceLimit } from "@gennety/shared";
import type { VenueCategory } from "./vibe-parser.js";
import { MIN_RATING, MIN_RATING_COUNT } from "./venue.js";

export const INITIAL_VENUE_MAX_PRICE: VenuePriceLimit = "moderate";
export const INITIAL_VENUE_ALLOWED_TIER = "base" as const;

export type InitialVenueRejectionReason =
  | "non_base_tier"
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

/**
 * Neutralise the participant constraints the product no longer offers.
 *
 * `maxPrice` was retired first: price is a product-owned policy for the initial
 * assignment, not a participant control.
 *
 * `dietary` / `alcoholFree` / `stepFree` were retired 2026-07-30 (founder
 * decision). They were enforced as hard filters requiring POSITIVE evidence on
 * the venue — `!== true` fails on "unknown" — and the catalog carried that
 * evidence for exactly zero of its 1207 rows, because Google publishes none of
 * it and no operator pass had marked any. So every one of those seven chips was
 * a guaranteed `no_candidates`, and the failure message then asked the user to
 * drop the requirement: a wheelchair user was told to relax step-free access,
 * someone keeping halal was told to relax halal. The product's answer is that
 * needs this specific belong to the person, not to the matchmaker — if the
 * assigned venue does not suit them they change it on the board (§3.7b) or the
 * couple simply walks somewhere else.
 *
 * Applied on BOTH read and write (`parseStored` and `confirmVenueIntent`), so a
 * cached Mini App bundle, an older native client, or an intent stored before
 * this change all resolve to the same neutral state. The enforcement code in
 * `satisfiesVenueHardConstraints` is deliberately left intact and simply goes
 * inert on empty/false input — re-enabling any of these is one line here, once
 * the catalog can actually back it.
 *
 * `setting` (indoor/outdoor) and `maxCommuteKm` are NOT retired: the catalog
 * carries `indoor` on 1136 rows and `outdoor` on 71, so they are answerable.
 */
export function applyInitialVenueConstraintPolicy(hard: VenueHardConstraints): VenueHardConstraints {
  return { ...hard, maxPrice: null, dietary: [], alcoholFree: false, stepFree: false };
}

/**
 * Categories that must prove a non-premium price before they can be the
 * automatic first assignment.
 *
 * `museum` is deliberately ABSENT (2026-07-30). It was here on the theory that
 * an admission venue can be expensive, but Google does not report `priceLevel`
 * for museums at all — measured across the curated catalog, 0 of 43 museum rows
 * carried one, so the rule rejected every museum that ever existed and the
 * `art_culture` experience was unreachable in the product. The protection it
 * was meant to give survives regardless: the `expensive` check below runs
 * BEFORE this one, so a museum with a known premium price is still refused.
 * What changed is only that "Google told us nothing" stopped meaning "too
 * expensive". Parks were never in this set (public space, no commercial price).
 */
const PRICE_EVIDENCE_REQUIRED = new Set<VenueCategory>([
  "cafe",
  "coffee_shop",
  "restaurant",
  "lounge",
]);

/**
 * Per-category quality floor.
 *
 * The 4.0 / 30-review bar is calibrated for commercial venues, where reviews
 * are plentiful and a low score is a real signal. Applied to public space it
 * mostly measures how many people bothered to rate an embankment: three of the
 * catalog's parks (Маріїнський парк, Воздвиженка, Оболонська набережна) carry
 * no Google rating at all and were rejected for it, even though they are
 * exactly the kind of operator-curated public place a walking date wants.
 *
 * So `park` keeps the same rating bar when a rating exists — a genuinely
 * badly-reviewed place is still refused — but needs far fewer reviews, and is
 * admitted on operator curation when the provider has no data whatsoever.
 */
export function qualityFloorFor(category: VenueCategory): { minRating: number; minReviews: number } {
  if (category === "park") return { minRating: MIN_RATING, minReviews: 5 };
  return { minRating: MIN_RATING, minReviews: MIN_RATING_COUNT };
}

/**
 * Standalone quality check, shared by the auto-assign policy and the paid
 * venue-change board so the two cannot drift. Takes the category as a plain
 * string because the board reads whatever the catalog row holds; an unknown
 * category falls back to the strict commercial floor.
 */
export function meetsVenueQualityFloor(
  category: string,
  rating: number | null | undefined,
  reviews: number | null | undefined,
): boolean {
  const floor = qualityFloorFor(category as VenueCategory);
  if (category === "park" && rating == null && reviews == null) return true;
  return (rating ?? 0) >= floor.minRating && (reviews ?? 0) >= floor.minReviews;
}

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
 * base-tier first assignment; price/exclusivity choices — and the operator's
 * `alternative` (heavier-cuisine) pool — belong to the post-assignment Venue
 * Change flow, where the couple picks for themselves.
 */
export function evaluateInitialVenuePolicy(input: InitialVenuePolicyInput): InitialVenuePolicyResult {
  if (input.tier !== INITIAL_VENUE_ALLOWED_TIER) {
    return { eligible: false, reason: "non_base_tier" };
  }
  const floor = qualityFloorFor(input.category);
  // Public space with no provider data at all rides on operator curation: a
  // named park in a hand-reviewed catalog is evidence, and "Google has no
  // rating for this embankment" is not a quality signal. Any data present is
  // still judged — a park rated 3.8 is refused like anything else.
  const hasProviderQuality = input.rating != null || input.reviews != null;
  const exemptUnrated = input.category === "park" && !hasProviderQuality;
  if (!exemptUnrated && ((input.rating ?? 0) < floor.minRating || (input.reviews ?? 0) < floor.minReviews)) {
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
