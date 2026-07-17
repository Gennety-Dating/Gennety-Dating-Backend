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
 *   - place type ∉ `BLOCKED_PLACE_TYPES` (no gas stations / hotels / shops —
 *     applies in strict AND relaxed mode; the main `searchText` leak path)
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
  /**
   * Absolute, operator-owned venue photo URL (curated venues only). Clean
   * licensing — safe to composite into the shareable date card. Null otherwise.
   */
  photoUrl?: string | null;
  /**
   * Google Places photo *resource name* (e.g. `places/X/photos/Y`) for venues
   * sourced from Places. The displayable media URL is built on demand with the
   * server-side API key (`buildPlacesPhotoUrl`) — we never persist Google's raw
   * bytes (Places ToS). Null for curated / stub venues.
   */
  photoName?: string | null;
  /**
   * Descriptive facts used to GROUND the scheduled-card venue blurb
   * (`services/venue-blurb.ts`). All optional / nullable — the blurb degrades to
   * category + the match's vibe when they're absent (curated / stub venues).
   * `editorialSummary` is Google's own short description; `primaryType` is the
   * Places place-type (or the curated category). Never invented downstream.
   */
  editorialSummary?: string | null;
  rating?: number | null;
  userRatingCount?: number | null;
  primaryType?: string | null;
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

// Exported so the re-validation cron applies the exact same quality floor the
// gate uses, rather than duplicating the thresholds.
export const MIN_RATING = 4.0;
export const MIN_RATING_COUNT = 30;
const MAX_RESULT_COUNT = 15;
/** Hard timeout for Google Places (New) REST calls — Node `fetch` has none by
 * default, so a stalled upstream would hang the date-lifecycle / location flow
 * forever (audit M1). */
const PLACES_TIMEOUT_MS = 15_000;

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

/**
 * Operator-level brand exclusions. These apply to curated rows, seeding, and
 * live Places fallback so removing a brand from the static catalog cannot let
 * it reappear through a later Google search.
 */
const BLOCKED_VENUE_NAME_FRAGMENTS = ["musafir", "мусафір", "мусафир"];

export function isBlockedVenueName(name: string | null | undefined): boolean {
  const normalized = name?.trim().toLocaleLowerCase() ?? "";
  return BLOCKED_VENUE_NAME_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

/**
 * Place types that must NEVER be proposed as a first-date venue, regardless
 * of rating/reviews. `searchNearby` already constrains by `includedTypes`,
 * but `searchText` (tier-3 fallback) does not — a high-rated petrol station
 * with a coffee corner used to leak through and get pitched as a date spot.
 *
 * Deny-list (not allow-list) on purpose: Google's New Places taxonomy has
 * hundreds of cuisine subtypes (`italian_restaurant`, `coffee_shop`, …) so a
 * positive allow-list would false-reject genuine venues. The deny-list only
 * needs to enumerate the obviously-wrong settings. A missing/empty `types`
 * is treated as NOT blocked. Positive quality curation lives in the curated
 * venue DB (separate work item).
 */
const BLOCKED_PLACE_TYPES: ReadonlySet<string> = new Set([
  "gas_station",
  "car_repair",
  "car_dealer",
  "car_wash",
  "car_rental",
  "auto_parts_store",
  "lodging",
  "hotel",
  "motel",
  "hostel",
  "resort_hotel",
  "bed_and_breakfast",
  "supermarket",
  "grocery_store",
  "convenience_store",
  "hospital",
  "pharmacy",
  "drugstore",
  "doctor",
  "dentist",
  "bank",
  "atm",
  "gym",
  "fitness_center",
  "parking",
  "storage",
  "moving_company",
  "hardware_store",
  "home_improvement_store",
  "warehouse_store",
  "gas_station",
]);

/** True if the place advertises any clearly-non-date venue type. */
function hasBlockedType(p: PlaceV1): boolean {
  if (p.primaryType && BLOCKED_PLACE_TYPES.has(p.primaryType)) return true;
  return (p.types ?? []).some((t) => BLOCKED_PLACE_TYPES.has(t));
}

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

/** One open/close window from Places `regularOpeningHours.periods[]`. */
export interface OpeningHoursPeriod {
  open?: { day?: number; hour?: number; minute?: number };
  /** Absent for always-open / 24h venues. */
  close?: { day?: number; hour?: number; minute?: number };
}

export interface RegularOpeningHours {
  periods?: OpeningHoursPeriod[];
  weekdayDescriptions?: string[];
}

interface PlaceV1 {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  businessStatus?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  regularOpeningHours?: RegularOpeningHours;
  utcOffsetMinutes?: number;
  photos?: { name?: string }[];
  editorialSummary?: { text?: string; languageCode?: string };
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
  "places.primaryType",
  "places.types",
  "places.id",
  "places.regularOpeningHours",
  "places.utcOffsetMinutes",
  "places.photos",
  "places.editorialSummary",
].join(",");

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

      // No tier produced a place that clears the quality gate. We deliberately
      // do NOT fall back to "any operational result" — that path used to pitch
      // gas stations / convenience stores as date venues. Throwing here routes
      // to the local stub (see `pickVenueAtMidpoint`), which is a safe, clearly
      // generic placeholder rather than a real-but-wrong place.
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
  if (isBlockedVenueName(p.displayName.text)) return false;
  if (p.businessStatus !== "OPERATIONAL") return false;
  // Hard type deny-list applies in BOTH strict and relaxed mode — relaxing
  // the price ceiling must never re-admit a gas station / hotel / etc.
  if (hasBlockedType(p)) return false;
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
    photoUrl: null,
    // Cover photo (first in the list is the highest-quality lead image).
    photoName: p.photos?.[0]?.name ?? null,
    // Grounding facts for the scheduled-card blurb (see `venue-blurb.ts`).
    editorialSummary: p.editorialSummary?.text ?? null,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    primaryType: p.primaryType ?? null,
  };
}

/**
 * Build a displayable Places photo media URL from a stored photo resource name.
 * The Places (New) media endpoint streams the image when given the resource
 * name + an API key. We build this on demand at render time so the API key is
 * never persisted alongside the match. Returns null when inputs are missing.
 */
export function buildPlacesPhotoUrl(
  photoName: string | null | undefined,
  apiKey: string | null | undefined,
  maxWidthPx = 1200,
): string | null {
  if (!photoName || !apiKey) return null;
  return (
    `https://places.googleapis.com/v1/${photoName}/media` +
    `?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`
  );
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
    signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Places API (New) searchText failed: ${res.status}`);
  }
  const json = (await res.json()) as SearchNearbyResponse;
  return json.places ?? [];
}

/** Liveness/quality snapshot of a single place, for the re-validation cron. */
export interface PlaceDetails {
  placeId: string;
  businessStatus: string | null;
  rating: number | null;
  userRatingCount: number | null;
  openingHours: RegularOpeningHours | null;
  utcOffsetMinutes: number | null;
}

const PLACE_DETAILS_FIELD_MASK = [
  "id",
  "businessStatus",
  "rating",
  "userRatingCount",
  "regularOpeningHours",
  "utcOffsetMinutes",
].join(",");

/**
 * Fetch the current state of a single place by its Places resource id
 * (Place Details). Used by the re-validation cron to detect closures / rating
 * drops and to refresh opening hours. Throws on a non-OK response so the caller
 * can distinguish an infra failure (don't deactivate) from a real "closed".
 */
export async function fetchPlaceDetails(
  apiKey: string,
  placeId: string,
): Promise<PlaceDetails> {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK,
      },
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`Places API (New) place details failed: ${res.status}`);
  }
  const p = (await res.json()) as PlaceV1;
  return {
    placeId: p.id ?? placeId,
    businessStatus: p.businessStatus ?? null,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    openingHours: p.regularOpeningHours ?? null,
    utcOffsetMinutes: p.utcOffsetMinutes ?? null,
  };
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

/**
 * Plain, reviewable candidate shape for the curated-venue seeder
 * (`scripts/seed-venues.mjs`). Carries the metadata an operator needs to
 * eyeball a place before approving it into `curated_venues`.
 */
export interface VenueCandidate {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  googleMapsUri: string | null;
  placeId: string | null;
  category: VenueCategory;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: string | null;
  primaryType: string | null;
  utcOffsetMinutes: number | null;
  openingHours: RegularOpeningHours | null;
  /**
   * Google Places photo *resource names* (`places/X/photos/Y`), best-first.
   * Resolved to displayable media via `buildPlacesPhotoUrl` (key stays
   * server-side). Used by the venue-change Mini App photo gallery.
   */
  photos: string[];
  /** Google's own short description (`editorialSummary`); null when absent. */
  editorialSummary: string | null;
}

/**
 * Search + gate + rank candidates for seeding the curated venue base. Reuses
 * the exact production quality gate (strict tier) and score, so the curated
 * pool inherits the same bar that filters out gas stations / closed / low-rated
 * places. Returns candidates sorted best-first; the seeder slices the top N.
 *
 * Unlike `pickVenueAtMidpoint` this does NOT fall back to text search or the
 * stub — a seeder run that finds nothing for a (domain, category) should report
 * zero candidates, not invent one.
 */
export async function searchVenueCandidates(
  apiKey: string,
  input: MidpointVenueInput,
): Promise<VenueCandidate[]> {
  const places = await searchNearby(apiKey, input);
  return places
    .filter((p) => gate(p, input.category, /* strict */ true))
    .map((p) => ({
      place: p,
      s: score(p, { lat: input.lat, lng: input.lng }, input.radiusMeters),
    }))
    .sort((x, y) => y.s - x.s)
    .map(({ place: p }) => ({
      name: p.displayName?.text ?? "",
      address: p.formattedAddress ?? "",
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      googleMapsUri: p.googleMapsUri ?? null,
      placeId: p.id ?? null,
      category: input.category,
      rating: p.rating ?? null,
      userRatingCount: p.userRatingCount ?? null,
      priceLevel: p.priceLevel ?? null,
      primaryType: p.primaryType ?? null,
      utcOffsetMinutes: p.utcOffsetMinutes ?? null,
      openingHours: p.regularOpeningHours ?? null,
      photos: (p.photos ?? [])
        .map((ph) => ph.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
      editorialSummary: p.editorialSummary?.text ?? null,
    }));
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
