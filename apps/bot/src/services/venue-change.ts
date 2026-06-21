/**
 * Venue change service (PRODUCT_SPEC §3.7 — female-exclusive one-shot swap).
 *
 * Pure eligibility/deadline logic + the catalog builder that backs the
 * "Change venue" Mini App. The catalog is **curated-first** (same first-party
 * `CuratedVenue` base as the auto-assign concierge picker), with a Google
 * Places fallback when no curated rows sit within range — exactly the strategy
 * in `curated-venue.ts`, but returning a *list* of alternatives instead of the
 * single best, and centered on the original venue rather than recomputing a
 * midpoint.
 *
 * Per the agreed design (implementation_plan.md, decision C2): the catalog is
 * centered on the original venue center already stored on the match
 * (`Match.venueLat/venueLng`, which is the fairness-balanced commute midpoint),
 * so a 3 km radius keeps both commutes within ~±10–15 min of the original.
 */

import { prisma } from "@gennety/db";
import {
  DATE_ALERT_HOURS,
  VENUE_CHANGE_RADIUS_KM,
  VENUE_CHANGE_TTL_HOURS,
} from "@gennety/shared";
import { haversineDistanceKm, type LatLng } from "./geo.js";
import { isVenueOpenAt } from "./curated-venue.js";
import {
  searchVenueCandidates,
  type RegularOpeningHours,
} from "./venue.js";
import type { VenueCategory } from "./vibe-parser.js";

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

export interface CatalogVenue {
  /** Where the row came from — drives whether `photoUrl` can be present. */
  source: "curated" | "places";
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUri: string | null;
  /** One of VENUE_CATEGORY_WHITELIST (string for transport simplicity). */
  category: string;
  /** Great-circle distance from the original venue center, km (rounded to 0.1). */
  distanceKm: number;
  /** Operator-supplied photo for curated rows; null for Places fallbacks. */
  photoUrl: string | null;
  /**
   * Google Places photo *resource names* for the detail-page gallery (Places
   * rows only; empty for curated). The Mini App resolves each to a displayable
   * image through the server-side `/v1/venue-change/photo` proxy so the
   * `PLACES_API_KEY` is never shipped to the client.
   */
  photoRefs: string[];
  /** Places quality signals surfaced on the venue detail page (null for curated). */
  rating: number | null;
  userRatingCount: number | null;
  /** Google's own short blurb about the place (Places rows only). */
  editorialSummary: string | null;
}

/** Max alternatives returned to the Mini App — keeps the card list scannable. */
export const VENUE_CHANGE_CATALOG_LIMIT = 12;

/** Per-venue photo cap so the catalog payload stays small. */
export const VENUE_CHANGE_PHOTOS_PER_VENUE = 6;

/**
 * Categories the Places fallback sweeps when no curated venue is in range. A
 * small, sensible spread of first-date-appropriate types — each is a separate
 * `searchNearby` call, so we keep the list short. Only runs in the fallback
 * branch, so the common (curated) path makes zero Places calls.
 */
const FALLBACK_CATEGORIES: VenueCategory[] = ["cafe", "restaurant", "park"];

// ---------------------------------------------------------------------------
// Pure eligibility + deadline
// ---------------------------------------------------------------------------

export type VenueChangeIneligibleReason =
  | "feature-disabled"
  | "not-participant"
  | "not-female-initiator"
  | "wrong-state"
  | "past-cutoff"
  | "already-used"
  | "no-venue";

export interface VenueChangeEligibilityInput {
  featureEnabled: boolean;
  status: string;
  callerUserId: string;
  userAId: string;
  userBId: string;
  genderA: string | null;
  genderB: string | null;
  agreedTime: Date | null;
  venueLat: number | null;
  venueLng: number | null;
  /** Non-null once a change has already been proposed (one-shot guard). */
  venueChangeProposedAt: Date | null;
  now: Date;
}

export type VenueChangeEligibility =
  | { ok: true; side: "A" | "B" }
  | { ok: false; reason: VenueChangeIneligibleReason };

/**
 * Decide whether `callerUserId` may propose a venue change right now.
 *
 * Female-exclusive (decision C3): the caller's own gender must be `female`.
 * In a hetero pair this naturally restricts it to the woman; in a female–
 * female pair both pass here and the one-shot `venueChangeProposedAt` guard
 * makes it first-tap-wins; a male–male pair has no female caller, so the
 * feature is simply unavailable.
 */
export function evaluateVenueChangeEligibility(
  input: VenueChangeEligibilityInput,
): VenueChangeEligibility {
  if (!input.featureEnabled) return { ok: false, reason: "feature-disabled" };

  const isA = input.callerUserId === input.userAId;
  const isB = input.callerUserId === input.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  if (input.status !== "scheduled") return { ok: false, reason: "wrong-state" };

  const callerGender = isA ? input.genderA : input.genderB;
  if (callerGender !== "female") {
    return { ok: false, reason: "not-female-initiator" };
  }

  if (input.venueChangeProposedAt) return { ok: false, reason: "already-used" };

  if (input.venueLat == null || input.venueLng == null) {
    return { ok: false, reason: "no-venue" };
  }

  if (!input.agreedTime) return { ok: false, reason: "wrong-state" };
  const cutoff = venueChangeCutoff(input.agreedTime);
  if (input.now.getTime() >= cutoff.getTime()) {
    return { ok: false, reason: "past-cutoff" };
  }

  return { ok: true, side: isA ? "A" : "B" };
}

/**
 * The latest instant a venue change may be *proposed*: the moment the T-5h
 * ice-breaker / emergency window opens (`agreedTime - DATE_ALERT_HOURS`). After
 * this the date is in its critical zone and the venue must be stable.
 */
export function venueChangeCutoff(agreedTime: Date): Date {
  return new Date(agreedTime.getTime() - DATE_ALERT_HOURS * 60 * 60 * 1000);
}

/**
 * The male's accept/decline deadline once a change is proposed:
 * `min(now + VENUE_CHANGE_TTL_HOURS, agreedTime - DATE_ALERT_HOURS)`. The
 * change must always resolve before the venue is locked for the date.
 */
export function venueChangeDeadline(now: Date, agreedTime: Date): Date {
  const ttl = new Date(now.getTime() + VENUE_CHANGE_TTL_HOURS * 60 * 60 * 1000);
  const cutoff = venueChangeCutoff(agreedTime);
  return ttl.getTime() < cutoff.getTime() ? ttl : cutoff;
}

// ---------------------------------------------------------------------------
// Catalog builder (curated-first, Places fallback)
// ---------------------------------------------------------------------------

export interface BuildCatalogInput {
  universityDomain: string | null;
  center: LatLng;
  agreedTime: Date;
  /** Radius cap; defaults to the product 3 km. */
  radiusKm?: number;
}

export interface BuildCatalogDeps {
  listCurated?: (input: BuildCatalogInput) => Promise<CatalogVenue[]>;
  listPlaces?: (input: BuildCatalogInput) => Promise<CatalogVenue[]>;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Curated rows for the pair's domain that sit within `radiusKm` of `center` and
 * are open at `agreedTime`. Sorted nearest-first.
 */
export async function listCuratedVenuesNear(
  input: BuildCatalogInput,
): Promise<CatalogVenue[]> {
  if (!input.universityDomain) return [];
  const radiusKm = input.radiusKm ?? VENUE_CHANGE_RADIUS_KM;

  const rows = await prisma.curatedVenue.findMany({
    where: { universityDomain: input.universityDomain, active: true },
    select: {
      name: true,
      address: true,
      lat: true,
      lng: true,
      googleMapsUri: true,
      category: true,
      photoUrl: true,
      utcOffsetMinutes: true,
      openingHours: true,
      placeId: true,
    },
  });

  const out: CatalogVenue[] = [];
  for (const r of rows) {
    const distanceKm = haversineDistanceKm(input.center, { lat: r.lat, lng: r.lng });
    if (distanceKm > radiusKm) continue;
    if (
      !isVenueOpenAt(
        (r.openingHours as RegularOpeningHours | null) ?? null,
        r.utcOffsetMinutes,
        input.agreedTime,
      )
    ) {
      continue;
    }
    out.push({
      source: "curated",
      placeId: r.placeId,
      name: r.name,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      mapsUri: r.googleMapsUri,
      category: r.category,
      distanceKm: round1(distanceKm),
      photoUrl: r.photoUrl,
      // Curated rows carry a single operator photo (above), no Places gallery
      // and no public rating/blurb in our base.
      photoRefs: [],
      rating: null,
      userRatingCount: null,
      editorialSummary: null,
    });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out;
}

/**
 * Places fallback: gated, deduped alternatives within `radiusKm` of `center`.
 * Reuses the production `searchVenueCandidates` (strict quality gate + score)
 * per category, then filters by exact distance and open-at-slot. Returns `[]`
 * when no `PLACES_API_KEY` is configured (dev / curated-only deploys).
 */
export async function listPlacesVenuesNear(
  input: BuildCatalogInput,
): Promise<CatalogVenue[]> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) return [];
  const radiusKm = input.radiusKm ?? VENUE_CHANGE_RADIUS_KM;
  const radiusMeters = Math.round(radiusKm * 1000);

  const byPlace = new Map<string, CatalogVenue>();
  for (const category of FALLBACK_CATEGORIES) {
    let candidates;
    try {
      candidates = await searchVenueCandidates(apiKey, {
        lat: input.center.lat,
        lng: input.center.lng,
        category,
        keywords: [],
        radiusMeters,
      });
    } catch (err) {
      console.warn(`[venue-change] Places fallback (${category}) failed:`, err);
      continue;
    }
    for (const c of candidates) {
      if (c.lat == null || c.lng == null) continue;
      const distanceKm = haversineDistanceKm(input.center, { lat: c.lat, lng: c.lng });
      if (distanceKm > radiusKm) continue;
      if (!isVenueOpenAt(c.openingHours, c.utcOffsetMinutes, input.agreedTime)) continue;
      const key = c.placeId ?? `${c.name}|${c.address}`;
      if (byPlace.has(key)) continue;
      byPlace.set(key, {
        source: "places",
        placeId: c.placeId,
        name: c.name,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        mapsUri: c.googleMapsUri,
        category: c.category,
        distanceKm: round1(distanceKm),
        photoUrl: null,
        photoRefs: c.photos.slice(0, VENUE_CHANGE_PHOTOS_PER_VENUE),
        rating: c.rating,
        userRatingCount: c.userRatingCount,
        editorialSummary: c.editorialSummary,
      });
    }
  }
  return [...byPlace.values()].sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Build the venue-change catalog: curated rows within range win; only when
 * none qualify do we sweep Google Places. Capped to keep the card list short.
 * `deps` is injectable for tests (no DB / network).
 */
export async function buildVenueChangeCatalog(
  input: BuildCatalogInput,
  deps: BuildCatalogDeps = {},
): Promise<CatalogVenue[]> {
  const listCurated = deps.listCurated ?? listCuratedVenuesNear;
  const listPlaces = deps.listPlaces ?? listPlacesVenuesNear;

  const curated = await listCurated(input);
  const chosen = curated.length > 0 ? curated : await listPlaces(input);
  return chosen.slice(0, VENUE_CHANGE_CATALOG_LIMIT);
}

/**
 * Server-side validation that a client-submitted pick is a legitimate catalog
 * entry: within range of the original venue and (best-effort) matching a
 * catalog row. We never trust the client's name/coords blindly — same stance
 * as `/v1/calendar/pick` validating against `proposedTimes`.
 */
export function isWithinRadius(
  center: LatLng,
  point: LatLng,
  radiusKm: number = VENUE_CHANGE_RADIUS_KM,
): boolean {
  return haversineDistanceKm(center, point) <= radiusKm;
}
