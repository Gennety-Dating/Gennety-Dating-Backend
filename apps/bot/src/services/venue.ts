/**
 * Venue picker service (Phase 3.4 — concierge flow).
 *
 * Uses Google **Places API (New) v1** (`places.googleapis.com/v1/...`)
 * — NOT the legacy `maps.googleapis.com/maps/api/place/nearbysearch/json`.
 * The new API:
 *   - Returns structured `priceLevel` (enum), `rating`, `userRatingCount`,
 *     `businessStatus`, `googleMapsUri`, `location` — letting us filter
 *     and rank without fragile heuristics on optional fields.
 *   - Requires explicit `X-Goog-FieldMask` to declare requested fields,
 *     which keeps cost/payload tight.
 *   - Has fresher data (the legacy path was returning long-closed places
 *     with `business_status` left undefined — see PRODUCT_SPEC.md §3.7).
 *
 * Quality gate ([gateCandidates]):
 *   - `businessStatus === "OPERATIONAL"` (strict — `undefined` is rejected,
 *     unlike the legacy implementation which let it through)
 *   - `userRatingCount >= MIN_RATING_COUNT`
 *   - `rating >= MIN_RATING`
 *   - `priceLevel ∈ STUDENT_FRIENDLY_PRICES` for `restaurant`/`lounge`
 *     (no price filter for `park`/`museum` — usually free anyway)
 *
 * Score (`rating * log10(userRatingCount + 10) * distanceFactor`) picks
 * the strongest candidate over the closest-but-mediocre one.
 *
 * Multi-step fallback so scheduling never wedges:
 *   1. searchNearby with strict gates
 *   2. searchNearby with relaxed price ceiling (allow EXPENSIVE)
 *   3. searchText biased on midpoint (catches non-categorised places
 *      that match the keyword)
 *   4. localStubVenueClient (last resort — match still finalises)
 *
 * AGENTS.md: no new dependencies. We use `fetch` + a typed wrapper
 * rather than pulling in `@googlemaps/google-maps-services-js`.
 */

import type { VenueCategory } from "./vibe-parser.js";

export interface Venue {
  name: string;
  address: string;
  /** Google Maps deep-link. Null when the picker fell back to the local stub. */
  googleMapsUri: string | null;
}

/** Legacy (pre-concierge) input. Retained for tests + rollback path. */
export interface VenueInput {
  universityDomainA: string | null;
  universityDomainB: string | null;
}

/** Concierge input — resolved midpoint + merged, whitelisted preferences. */
export interface MidpointVenueInput {
  lat: number;
  lng: number;
  category: VenueCategory;
  keywords: string[];
  radiusMeters: number;
}

export interface VenueClient {
  pick(input: VenueInput): Promise<Venue>;
  pickAtMidpoint?(input: MidpointVenueInput): Promise<Venue>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MIN_RATING = 4.0;
const MIN_RATING_COUNT = 30;
const MAX_RESULT_COUNT = 15;

/**
 * Price levels considered student-friendly. PRICE_LEVEL_FREE / _UNSPECIFIED
 * are always accepted (parks, museums, places with unknown pricing).
 * EXPENSIVE / VERY_EXPENSIVE are excluded for food categories so we don't
 * push two students into a $80/head dinner on a first date. Re-included
 * by the relaxed-fallback step.
 */
const STUDENT_FRIENDLY_PRICES: ReadonlySet<string> = new Set([
  "PRICE_LEVEL_UNSPECIFIED",
  "PRICE_LEVEL_FREE",
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
]);

const FOOD_CATEGORIES: ReadonlySet<VenueCategory> = new Set<VenueCategory>([
  "cafe",
  "coffee_shop",
  "restaurant",
  "lounge",
]);

/** Category → Places API (New) `includedTypes`. */
const PLACES_TYPE_MAP: Record<VenueCategory, string[]> = {
  cafe: ["cafe"],
  coffee_shop: ["cafe", "coffee_shop"],
  restaurant: ["restaurant"],
  park: ["park"],
  museum: ["museum"],
  lounge: ["bar"],
};

// ---------------------------------------------------------------------------
// Local stub
// ---------------------------------------------------------------------------

const STUB_CAFES: Record<string, Venue> = {
  "stanford.edu": {
    name: "Coupa Café",
    address: "538 Ramona St, Palo Alto, CA",
    googleMapsUri: null,
  },
  "mit.edu": {
    name: "Flour Bakery + Café",
    address: "190 Massachusetts Ave, Cambridge, MA",
    googleMapsUri: null,
  },
  "ox.ac.uk": {
    name: "Vaults & Garden Café",
    address: "University Church, Oxford",
    googleMapsUri: null,
  },
  "cam.ac.uk": {
    name: "Fitzbillies",
    address: "51-52 Trumpington St, Cambridge",
    googleMapsUri: null,
  },
};

export function localStubVenueClient(): VenueClient {
  return {
    async pick(input: VenueInput): Promise<Venue> {
      const a = input.universityDomainA;
      const b = input.universityDomainB;
      if (a && a === b && STUB_CAFES[a]) return STUB_CAFES[a];
      if (a && STUB_CAFES[a]) return STUB_CAFES[a];
      if (b && STUB_CAFES[b]) return STUB_CAFES[b];
      return {
        name: "Campus Café",
        address: "Near your university",
        googleMapsUri: null,
      };
    },
    async pickAtMidpoint(input: MidpointVenueInput): Promise<Venue> {
      const label = input.keywords[0]
        ? `${input.keywords[0]} ${input.category}`
        : input.category;
      return {
        name: `Neighbourhood ${label}`.replace(/_/g, " "),
        address: `Near ${input.lat.toFixed(3)}, ${input.lng.toFixed(3)}`,
        googleMapsUri: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Places API (New) v1 client
// ---------------------------------------------------------------------------

interface PlaceV1 {
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  businessStatus?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  location?: { latitude?: number; longitude?: number };
}

interface SearchNearbyResponse {
  places?: PlaceV1[];
}

const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.businessStatus",
  "places.priceLevel",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.location",
].join(",");

/** Internal: enriched candidate with computed score. */
interface ScoredPlace {
  place: PlaceV1;
  score: number;
}

export function createPlacesVenueClient(apiKey: string): VenueClient {
  return {
    async pick(input: VenueInput): Promise<Venue> {
      // Legacy domain-based path uses the same searchText endpoint with
      // a coarse query. Kept for rollback / when no midpoint is available.
      const query = `cafe near ${input.universityDomainA ?? input.universityDomainB ?? "university"}`;
      const places = await searchText(apiKey, query, null);
      const first = places[0];
      if (!first?.displayName?.text) {
        throw new Error("Places API returned no results");
      }
      return placeToVenue(first);
    },

    async pickAtMidpoint(input: MidpointVenueInput): Promise<Venue> {
      // Step 1 — strict filters
      const strictGate = (p: PlaceV1) => gate(p, input.category, /* strict */ true);
      const tier1 = await searchNearby(apiKey, input);
      const strictPicked = pickBest(tier1, input, strictGate);
      if (strictPicked) return placeToVenue(strictPicked);

      // Step 2 — relax price ceiling for food categories. Other gates
      // (operational + rating + count) stay in place.
      const relaxedGate = (p: PlaceV1) => gate(p, input.category, /* strict */ false);
      const relaxedPicked = pickBest(tier1, input, relaxedGate);
      if (relaxedPicked) return placeToVenue(relaxedPicked);

      // Step 3 — text search with the keyword + category, biased on the
      // midpoint. Catches places that aren't categorised in `includedTypes`
      // but match the keyword (e.g. a "gallery cafe" indexed only as
      // gallery).
      const kw = input.keywords.join(" ");
      const query = (kw ? `${kw} ${input.category}` : input.category).replace(
        /_/g,
        " ",
      );
      const tier3 = await searchText(apiKey, query, {
        lat: input.lat,
        lng: input.lng,
        radiusMeters: input.radiusMeters,
      });
      const tier3Picked = pickBest(tier3, input, relaxedGate);
      if (tier3Picked) return placeToVenue(tier3Picked);

      // Step 4 — give up: surface ANY operational result so the user
      // gets *something*. Last guardrail before the local stub.
      const anyOperational = tier3.find(
        (p) => p.businessStatus === "OPERATIONAL" && p.displayName?.text,
      );
      if (anyOperational) return placeToVenue(anyOperational);
      throw new Error("Places API returned no usable results");
    },
  };
}

/**
 * Quality gate. Returns true if the place passes all category-appropriate
 * filters. Pure function — used inside `pickBest` and in tests.
 */
export function gate(
  p: PlaceV1,
  category: VenueCategory,
  strict: boolean,
): boolean {
  if (!p.displayName?.text) return false;
  if (p.businessStatus !== "OPERATIONAL") return false;
  if ((p.userRatingCount ?? 0) < MIN_RATING_COUNT) return false;
  if ((p.rating ?? 0) < MIN_RATING) return false;
  // Price gate only applies to food categories (parks/museums often
  // have no price level published, would be falsely rejected).
  if (strict && FOOD_CATEGORIES.has(category)) {
    const pl = p.priceLevel ?? "PRICE_LEVEL_UNSPECIFIED";
    if (!STUDENT_FRIENDLY_PRICES.has(pl)) return false;
  }
  return true;
}

/**
 * Score a candidate. Higher = better.
 * `rating × log10(reviews + 10) × distanceFactor` — the log dampens the
 * "10000 reviews vs 100 reviews" gap (both are fine), and distance gently
 * penalises far places without dominating quality.
 */
export function score(
  p: PlaceV1,
  midpoint: { lat: number; lng: number },
  radiusMeters: number,
): number {
  const rating = p.rating ?? 0;
  const reviews = p.userRatingCount ?? 0;
  const reviewWeight = Math.log10(reviews + 10);
  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  let distanceFactor = 1;
  if (lat != null && lng != null) {
    const km = haversineKm(midpoint.lat, midpoint.lng, lat, lng);
    const radiusKm = radiusMeters / 1000;
    // Linear 1.0 → 0.5 over the search radius. Anything beyond gets 0.5
    // floor so a famous place 1.5 km outside the radius can still beat
    // an unknown one inside.
    distanceFactor = Math.max(0.5, 1 - (km / radiusKm) * 0.5);
  }
  return rating * reviewWeight * distanceFactor;
}

function pickBest(
  places: PlaceV1[],
  input: MidpointVenueInput,
  gateFn: (p: PlaceV1) => boolean,
): PlaceV1 | null {
  let bestPlace: PlaceV1 | null = null;
  let bestScore = -Infinity;
  for (const p of places) {
    if (!gateFn(p)) continue;
    const s = score(p, { lat: input.lat, lng: input.lng }, input.radiusMeters);
    if (s > bestScore) {
      bestScore = s;
      bestPlace = p;
    }
  }
  return bestPlace;
}

function placeToVenue(p: PlaceV1): Venue {
  return {
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    googleMapsUri: p.googleMapsUri ?? null,
  };
}

async function searchNearby(
  apiKey: string,
  input: MidpointVenueInput,
): Promise<PlaceV1[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: PLACES_TYPE_MAP[input.category],
      maxResultCount: MAX_RESULT_COUNT,
      locationRestriction: {
        circle: {
          center: { latitude: input.lat, longitude: input.lng },
          radius: input.radiusMeters,
        },
      },
      rankPreference: "POPULARITY",
    }),
  });
  if (!res.ok) {
    throw new Error(`Places API (New) searchNearby failed: ${res.status}`);
  }
  const json = (await res.json()) as SearchNearbyResponse;
  return json.places ?? [];
}

interface TextSearchBias {
  lat: number;
  lng: number;
  radiusMeters: number;
}

async function searchText(
  apiKey: string,
  query: string,
  bias: TextSearchBias | null,
): Promise<PlaceV1[]> {
  const body: Record<string, unknown> = { textQuery: query };
  if (bias) {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: bias.radiusMeters,
      },
    };
  }
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Places API (New) searchText failed: ${res.status}`);
  }
  const json = (await res.json()) as SearchNearbyResponse;
  return json.places ?? [];
}

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// High-level entry points
// ---------------------------------------------------------------------------

export async function pickVenueForMatch(
  input: VenueInput,
  client?: VenueClient,
): Promise<Venue> {
  const apiKey = process.env.PLACES_API_KEY ?? "";
  const impl = client ?? (apiKey ? createPlacesVenueClient(apiKey) : localStubVenueClient());
  try {
    return await impl.pick(input);
  } catch (err) {
    console.warn("Venue pick failed, using stub:", err);
    return localStubVenueClient().pick(input);
  }
}

export async function pickVenueAtMidpoint(
  input: MidpointVenueInput,
  client?: VenueClient,
): Promise<Venue> {
  const apiKey = process.env.PLACES_API_KEY ?? "";
  const impl = client ?? (apiKey ? createPlacesVenueClient(apiKey) : localStubVenueClient());
  try {
    if (impl.pickAtMidpoint) {
      return await impl.pickAtMidpoint(input);
    }
    return await localStubVenueClient().pickAtMidpoint!(input);
  } catch (err) {
    console.warn("Midpoint venue pick failed, using stub:", err);
    return localStubVenueClient().pickAtMidpoint!(input);
  }
}
