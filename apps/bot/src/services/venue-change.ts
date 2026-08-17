/**
 * Venue change service (PRODUCT_SPEC §3.7b — paid multiplayer likes board).
 *
 * Pure eligibility/deadline logic + the catalog builder that backs the
 * "Change venue" Mini App. The catalog is **curated-first** (same first-party
 * `CuratedVenue` base as the auto-assign concierge picker), with a Google
 * Places fallback when no curated rows sit within range — exactly the strategy
 * in `curated-venue.ts`, but returning a *list* of alternatives instead of the
 * single best, and centered on the original venue rather than recomputing a
 * midpoint.
 *
 * Per the agreed design (VENUE_CHANGE_PRODUCT_SPEC.md, decision C2): the catalog is
 * centered on the original venue center already stored on the match
 * (`Match.venueLat/venueLng`, which is the fairness-balanced commute midpoint),
 * so a 3 km radius keeps both commutes within ~±10–15 min of the original.
 */

import { prisma } from "@gennety/db";
import {
  DATE_ALERT_HOURS,
  VENUE_CHANGE_MAX_PER_DATE,
  VENUE_CHANGE_PREMIUM_RADIUS_KM,
  VENUE_CHANGE_RADIUS_KM,
  VENUE_CHANGE_TTL_HOURS,
} from "@gennety/shared";
import { haversineDistanceKm, type LatLng } from "./geo.js";
import { isVenueOpenAt, OFFERABLE_CATEGORY_FILTER } from "./curated-venue.js";
import { meetsVenueQualityFloor } from "./initial-venue-policy.js";
import {
  fetchPlacePhotoNames,
  searchVenueCandidates,
  type RegularOpeningHours,
} from "./venue.js";
import type { VenueCategory } from "./vibe-parser.js";

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

export interface CatalogVenue {
  /** Where the row came from — drives which display fields can be present. */
  source: "curated" | "places";
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUri: string | null;
  /** One of VENUE_CATEGORY_WHITELIST (string for transport simplicity). */
  category: string;
  /**
   * `base` (student-friendly, always selectable) or `premium` (Gennety Premium
   * tier — shown but locked unless a participant has an active subscription; may
   * exceed the ≤ MODERATE price cap). Places-fallback rows are always `base`.
   * See PRODUCT_SPEC.md §Premium.
   */
  tier: string;
  /** Great-circle distance from the original venue center, km (rounded to 0.1). */
  distanceKm: number;
  /**
   * Google Places photo *resource names* for the board card + detail-page
   * gallery — the single source of venue imagery. Populated for Places rows
   * from the search response; empty for curated rows, which store none (the
   * board shows a category placeholder, and the winner's cover is resolved from
   * its `placeId` when the change is agreed). The Mini App resolves each ref to
   * a displayable image through the server-side `/v1/venue-change/photo` proxy
   * so the `PLACES_API_KEY` is never shipped to the client.
   */
  photoRefs: string[];
  /** Places quality signals surfaced on the venue detail page (null for curated). */
  rating: number | null;
  userRatingCount: number | null;
  /** Google's own short blurb about the place (Places rows only). */
  editorialSummary: string | null;
}

/**
 * Max alternatives returned to the Mini App.
 *
 * Raised 12 → 21 (founder decision 2026-08-18) for a more varied choice. The
 * catalog carries it: measured over every possible board centre in the live
 * Kyiv catalog, the median centre has ~138 candidates in range, and the share
 * of centres that can fill a board barely moves (89% at 12, 86% at 21) — the
 * few that cannot are the same outlying points that could not fill 12 either.
 *
 * **The cost is not scroll length, it is agreement.** This board is a
 * coordination mechanism, not a browsable catalog: a change settles only when
 * both sides heart the SAME venue. Widening the board lowers that collision
 * probability — modelling k independent picks out of N, three hearts each goes
 * from ~62% at 12 to ~39% at 21. Real overlap is higher (both are drawn to the
 * nearest and the nicest, not to a uniform random pick), but the direction is
 * the trade being made: more variety is paid for in rounds of hearting, and the
 * pair lands more often in the both-picked-nothing-matched state, which shows
 * no status at all (§3.6b) and waits on the 6h/12h reminder.
 *
 * Raising this alone does NOT buy variety, only more cafés — the reserves
 * below are what make the extra slots land on different KINDS of place, so
 * they move together with it.
 */
export const VENUE_CHANGE_CATALOG_LIMIT = 21;

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
  | "wrong-state"
  | "past-cutoff"
  | "already-changed"
  | "no-venue";

export interface VenueBoardEligibilityInput {
  featureEnabled: boolean;
  status: string;
  callerUserId: string;
  userAId: string;
  userBId: string;
  agreedTime: Date | null;
  venueLat: number | null;
  venueLng: number | null;
  /** Current v2 sub-state: null | liking | agreed | settled | lapsed. */
  venueChangeStatus: string | null;
  now: Date;
}

export type VenueBoardEligibility =
  | { ok: true; side: "A" | "B" }
  | { ok: false; reason: VenueChangeIneligibleReason };

/**
 * Decide whether `callerUserId` may interact with the venue board right now
 * (v2 — both participants may). "Interact" = view/like/confirm; the payment
 * actions layer their own payer checks on top.
 *
 * A `settled`/`lapsed` session is closed HERE and stays closed: this predicate
 * is about acting on a live session, and there is none. Starting a fresh round
 * on top of a finished one is a different question with a different answer —
 * see `evaluateVenueChangeRestart`, which the four entry points that know how
 * to wipe the previous round ask instead.
 */
export function evaluateVenueBoardEligibility(
  input: VenueBoardEligibilityInput,
): VenueBoardEligibility {
  if (!input.featureEnabled) return { ok: false, reason: "feature-disabled" };

  const isA = input.callerUserId === input.userAId;
  const isB = input.callerUserId === input.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  if (input.status !== "scheduled") return { ok: false, reason: "wrong-state" };

  if (input.venueChangeStatus === "settled" || input.venueChangeStatus === "lapsed") {
    return { ok: false, reason: "already-changed" };
  }

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

/** Terminal session states a fresh round can be started FROM. */
const RESTARTABLE_STATUSES = new Set(["settled", "lapsed"]);

export type VenueChangeRestartReason =
  | VenueChangeIneligibleReason
  /** The cap on settled changes for this date is used up. */
  | "budget-spent"
  /** There is a live session already — the ordinary board gate governs, not this. */
  | "session-live";

export interface VenueChangeRestartInput extends VenueBoardEligibilityInput {
  /** `Match.venueChangeCount` — how many changes have actually settled. */
  venueChangeCount: number;
}

export type VenueChangeRestart =
  | { ok: true; side: "A" | "B" }
  | { ok: false; reason: VenueChangeRestartReason };

/**
 * May `callerUserId` start a NEW venue-change round on a date whose previous
 * session already ended (`settled` or `lapsed`)?
 *
 * Deliberately a second predicate rather than a loosening of
 * `evaluateVenueBoardEligibility`. That one answers "is there a live session I
 * may act on", and eight call sites read it — keep-original, offer-pay,
 * confirm-overlap and pay-decline among them. Widening it in place would let
 * every one of those run against a *finished* session whose `venueChange*`
 * columns still hold the previous round: keep-original would resurrect a
 * `liking` state out of stale likes, and offer-pay would find its one-shot
 * stamp already spent. Only the four entry points that know how to reset the
 * session ask this question instead (state, catalog, likes, express mint).
 *
 * A lapse is restartable on the same terms as a settle. Those two look
 * different but end the same way — the originally-assigned venue stands — and
 * the product already reopens the board on the third such path: the male's
 * "not this time" sets the status back to null outright. Leaving `lapsed`
 * terminal alone was an accident of where the reset happened to be written,
 * not a decision. It costs no budget because nothing was ever paid.
 */
export function evaluateVenueChangeRestart(
  input: VenueChangeRestartInput,
): VenueChangeRestart {
  if (!input.featureEnabled) return { ok: false, reason: "feature-disabled" };

  const isA = input.callerUserId === input.userAId;
  const isB = input.callerUserId === input.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  if (input.status !== "scheduled") return { ok: false, reason: "wrong-state" };

  if (!RESTARTABLE_STATUSES.has(input.venueChangeStatus ?? "")) {
    return { ok: false, reason: "session-live" };
  }

  if (input.venueChangeCount >= VENUE_CHANGE_MAX_PER_DATE) {
    return { ok: false, reason: "budget-spent" };
  }

  if (input.venueLat == null || input.venueLng == null) {
    return { ok: false, reason: "no-venue" };
  }

  // The T-5h cutoff binds a restart exactly as it binds a first change: past it
  // the ice-breakers have gone out naming a venue, and it must stop moving.
  if (!input.agreedTime) return { ok: false, reason: "wrong-state" };
  if (input.now.getTime() >= venueChangeCutoff(input.agreedTime).getTime()) {
    return { ok: false, reason: "past-cutoff" };
  }

  return { ok: true, side: isA ? "A" : "B" };
}

/**
 * Everything a finished round leaves behind, cleared as one unit when a new
 * round starts. These columns are a single slot, not a history, so a restart
 * that reset only some of them would inherit the previous round's state in
 * ways that are individually subtle and collectively broken:
 *
 *   • both `venueLikes*` — clearing only the restarter's side leaves the
 *     partner's old hearts live, and the very first like of round two would
 *     "overlap" them into an agreement on a venue nobody is currently choosing;
 *   • `venueChangeProposerId` — decides the payer matrix and the she-initiated
 *     fork, so round two would be billed to round one's initiator;
 *   • `venueChangeOfferPaySentAt` — one wish card per session; unreset, she
 *     could never hand the payment over again;
 *   • `venueChangePaidAt` — `venueChangeSideWaiting` reads it as "settled,
 *     nothing to wait for", so the peer-wait shimmer would stay dead all round;
 *   • the ping ids — they point at messages belonging to the finished round.
 *
 * The agreed-venue snapshot itself is safe to drop: a settle has already copied
 * it onto the canonical `venue*` fields, and a lapse deliberately discarded it.
 *
 * A factory rather than a shared constant so no caller can hand Prisma the same
 * `[]` instance twice, and so the object is safe to spread into and mutate.
 */
export function venueChangeSessionReset(): Record<string, unknown> {
  return {
    venueLikesA: [],
    venueLikesB: [],
    venueChangeName: null,
    venueChangeAddress: null,
    venueChangeLat: null,
    venueChangeLng: null,
    venueChangeMapsUri: null,
    venueChangePlaceId: null,
    venueChangePhotoName: null,
    venueChangeTier: null,
    venueChangeExpiresAt: null,
    venueChangeResolvedAt: null,
    venueChangeExpressAt: null,
    venueChangePaidById: null,
    venueChangePaidAt: null,
    venueChangeProposerId: null,
    venueChangeProposedAt: null,
    venueChangeOfferPaySentAt: null,
    venueChangePayDeclinedAt: null,
    venueChangePingSentToAAt: null,
    venueChangePingSentToBAt: null,
    venueChangePingMsgIdA: null,
    venueChangePingMsgIdB: null,
  };
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
  /**
   * Primary scope key — matches `curated_venues.cityKey` (ARCHITECTURE.md:
   * "University domain is now affinity only"). Wins over `universityDomain`
   * when both are present, mirroring `venue-intent-v2.ts`'s auto-assign
   * selector. Required for a general/phone-track pair, who never have a
   * `universityDomain` at all — without this scope, the curated catalog
   * (base + premium + alternative) was silently empty for them and the
   * board fell through to the un-tiered Places fallback, which can never
   * show a premium badge.
   */
  cityKey: string | null;
  universityDomain: string | null;
  center: LatLng;
  agreedTime: Date;
  /** Radius cap for base/alternative venues; defaults to the product 3 km. */
  radiusKm?: number;
  /**
   * Radius cap for `premium` venues only; defaults to
   * `VENUE_CHANGE_PREMIUM_RADIUS_KM` (5 km). See that constant for why the
   * premium tier reaches further than the rest of the board.
   */
  premiumRadiusKm?: number;
  /**
   * Include `premium`-tier curated venues in the catalog (shown but locked in
   * the board). Pass `PREMIUM_FEATURE_ENABLED`; when false the catalog is
   * base + `alternative` only, so premium venues never surface while the
   * feature is off. `alternative` venues are NOT gated by this — they are
   * unlocked board-only inventory. Places-fallback rows are always base.
   * See PRODUCT_SPEC.md §Premium / §3.7b.
   */
  includePremium?: boolean;
  /**
   * Stable seed for the tail shuffle in `capCatalog` — pass the match id. The
   * board is re-fetched (Mini App reopen, post-unlock repaint), so the scatter
   * MUST be deterministic per match: an unseeded `Math.random()` would deal a
   * different order every fetch and the cards would visibly jump under the
   * user. Omitted → stable distance order, no scatter.
   */
  seed?: string;
  /**
   * Resolve missing cover photos for curated rows (see `withCuratedPhotos`).
   * Set ONLY by the board read (`getVenueChangeCatalog`). The like and confirm
   * paths rebuild the same catalog purely to re-resolve a submitted key against
   * the server's own list — they render nothing, so making a user's tap wait on
   * Places lookups would buy them nothing.
   */
  withPhotos?: boolean;
  /**
   * The currently-assigned venue, which is dropped from the alternatives.
   *
   * The board already offers it as the pinned "keep this place" card under the
   * `KEEP_KEY` sentinel, and it is usually a curated row in its own city — so
   * without this it appears TWICE on screen, once pinned and once as an
   * ordinary alternative. That is not only visual noise: the two cards do
   * different things. Agreeing on `KEEP_KEY` keeps the venue for free and
   * closes the session, while agreeing on the same place under its own key
   * takes the paid path — charging `VENUE_CHANGE_STARS` to "change" to the
   * venue the pair already has. Excluding it here (rather than in the client)
   * also means the like/confirm rebuilds refuse that key as `invalid-venue`.
   */
  excludeVenue?: { placeId: string | null; name: string; address: string } | null;
}

export interface BuildCatalogDeps {
  listCurated?: (input: BuildCatalogInput) => Promise<CatalogVenue[]>;
  listPlaces?: (input: BuildCatalogInput) => Promise<CatalogVenue[]>;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The identity of a venue on this board — the SAME key `venueKeyOf`
 * (`handlers/matching/venue-change.ts`) uses to resolve a client's pick, so a
 * row deduped here is a row that was already collapsing into one like anyway.
 */
function curatedKeyOf(row: { placeId: string | null; name: string; address: string }): string {
  return row.placeId ?? `${row.name}|${row.address}`;
}

/**
 * Curated rows for the pair's city/domain that sit within range of `center` and
 * are open at `agreedTime`. Sorted nearest-first, one card per real venue.
 *
 * Two things here are load-bearing:
 *
 * **Dedup.** The catalog is scoped by `cityKey`, and the curated base stores one
 * ROW PER UNIVERSITY DOMAIN — in Kyiv that is 538 active rows for 127 actual
 * venues, every one of them five-fold (90 premium rows = 18 venues). The copies
 * share coordinates, so they sort adjacently and a distance-ordered board became
 * the same three places repeated four times each. The old `universityDomain`
 * scope hid this by accident, taking exactly one copy; `cityKey` takes all five.
 * The auto-assign selector has always deduped by place id
 * (`venue-intent-v2.ts`) — this brings the board onto the same footing.
 *
 * **Per-tier radius.** Premium venues are matched against `premiumRadiusKm`
 * rather than `radiusKm`; see `VENUE_CHANGE_PREMIUM_RADIUS_KM`.
 */
export async function listCuratedVenuesNear(
  input: BuildCatalogInput,
): Promise<CatalogVenue[]> {
  if (!input.cityKey && !input.universityDomain) return [];
  const radiusKm = input.radiusKm ?? VENUE_CHANGE_RADIUS_KM;
  const premiumRadiusKm = input.premiumRadiusKm ?? VENUE_CHANGE_PREMIUM_RADIUS_KM;

  const rows = await prisma.curatedVenue.findMany({
    where: {
      // `cityKey` is the primary scope; `universityDomain` is affinity-only
      // and kept as the fallback for rows never backfilled with a city (see
      // `BuildCatalogInput.cityKey`).
      ...(input.cityKey ? { cityKey: input.cityKey } : { universityDomain: input.universityDomain }),
      active: true,
      // `alternative` venues exist ONLY for this board (never auto-assigned),
      // so they are always in — unlocked and priced like base. Premium venues
      // only surface when the feature is on (they're then shown locked).
      tier: input.includePremium
        ? { in: ["base", "premium", "alternative"] }
        : { in: ["base", "alternative"] },
      // Same product-level exclusion as the automatic assignment: a category we
      // never pick FOR the pair should not be offered TO them either.
      category: { notIn: OFFERABLE_CATEGORY_FILTER },
    },
    select: {
      name: true,
      address: true,
      lat: true,
      lng: true,
      googleMapsUri: true,
      category: true,
      tier: true,
      utcOffsetMinutes: true,
      openingHours: true,
      placeId: true,
      // Feed the quality floor below. Not surfaced to the client for curated
      // rows (the board shows no rating for them), only used to gate.
      rating: true,
      userRatingCount: true,
    },
    // Freshest copy first, so the dedup below keeps the one the re-validation
    // cron confirmed most recently. The per-domain copies are identical today
    // in every field this function reads (verified against production: 0 drift
    // across 111 duplicated Kyiv venues), but the cron refreshes them one by
    // one, so which copy survives should be a decision rather than an accident.
    orderBy: { lastVerifiedAt: { sort: "desc", nulls: "last" } },
  });

  const out: CatalogVenue[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // One card per real venue — the per-university-domain copies are the same
    // place. First copy wins; they are identical apart from the domain.
    const key = curatedKeyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const distanceKm = haversineDistanceKm(input.center, { lat: r.lat, lng: r.lng });
    if (distanceKm > (r.tier === "premium" ? premiumRadiusKm : radiusKm)) continue;
    // Quality floor — the board had none, so a row the auto-assign picker would
    // refuse (and one the nightly revalidation had already deactivated, until
    // the importer stopped resurrecting them) was still offered here as a
    // pickable option. Same category-aware floor as the initial assignment;
    // price/tier rules deliberately do NOT apply, since paying for a premium or
    // alternative venue is exactly what this board is for.
    if (!meetsVenueQualityFloor(r.category, r.rating, r.userRatingCount)) continue;
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
      tier: r.tier,
      distanceKm: round1(distanceKm),
      // Curated rows store no imagery and no public rating/blurb in our base.
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
        // Places-fallback rows are always base (they pass the ≤ MODERATE gate).
        tier: "base",
        distanceKm: round1(distanceKm),
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
 * Leading slots reserved for premium venues. Product intent (§Premium upsell):
 * a non-subscriber must see the locked tier immediately, at the top, before
 * anything else — not distance-sorted in with base where it can land mid-list.
 *
 * Raised 3 → 5 with the board's 12 → 21 widening, because this is a SHARE of
 * the board rather than an absolute count: three pinned cards owned a quarter
 * of a twelve-card board and would have owned an eighth of a twenty-one-card
 * one, halving the reach of the mechanic without anyone deciding to. Fillable
 * essentially always — 90% of Kyiv centres have at least five premium venues
 * inside `VENUE_CHANGE_PREMIUM_RADIUS_KM` (median 41).
 */
export const VENUE_CHANGE_PREMIUM_PINNED = 5;

/**
 * Total premium cards allowed on the board (pinned + scattered). The premium
 * pool near a central venue can easily exceed the whole catalog limit, and a
 * board that is mostly padlocks reads as a paywall rather than a choice — the
 * user still needs real, pickable options. Anything past this is dropped.
 *
 * Raised 5 → 8 with the board's 12 → 21 widening, holding the paywall-wall
 * guard proportional: eight of twenty-one is a slightly smaller share of the
 * board than five of twelve was, so the ceiling has not been loosened in the
 * sense that matters. Must stay above `VENUE_CHANGE_PREMIUM_PINNED`, or the
 * scatter step below has nothing to distribute and every locked card stacks at
 * the top — the exact shape this constant exists to prevent.
 */
export const VENUE_CHANGE_PREMIUM_MAX = 8;

/**
 * How long a resolved photo set is trusted. Places photo names can rotate, so
 * this is a freshness bound, not just a cost one. A day is comfortably shorter
 * than that rotation and long enough that a city warms up once per process.
 */
const PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long an EMPTY answer is remembered — a failed lookup, or a 200 that
 * carried no photos. Deliberately short: a timeout or a Places outage must not
 * cost the board its photos for a whole day, but it also must not turn every
 * board open into a retry storm against a service that is already struggling.
 */
const PHOTO_CACHE_FAILURE_TTL_MS = 5 * 60 * 1000;

/** Parallel Place Details lookups per board build. */
const PHOTO_LOOKUP_CONCURRENCY = 4;

interface PhotoCacheEntry {
  refs: string[];
  expiresAt: number;
}

/**
 * `placeId` → its photo refs. In-process and unbounded-by-design: the whole
 * curated catalog of a launched market is ~130 venues, so this tops out at a
 * few hundred short strings even with every city loaded. Same single-process
 * assumption as `services/usage-limiter.ts` — a PM2 restart simply re-warms it.
 */
const photoCache = new Map<string, PhotoCacheEntry>();

/** Test seam — the cache is module state, so a test must be able to reset it. */
export function __resetVenuePhotoCacheForTests(): void {
  photoCache.clear();
}

/**
 * Fill in `photoRefs` for curated rows, which store no imagery of their own.
 *
 * This is what puts pictures back on the board. Curated rows have always
 * carried `photoRefs: []`, and it went unnoticed because until the catalog was
 * scoped by `cityKey` the curated branch never matched in production at all —
 * every board fell through to the Places sweep, which carries photos in its
 * search response. Once curated started winning, the board lost its imagery by
 * construction. Every curated row does hold a stable `placeId`, so the photos
 * are one Place Details request away (verified: 127/127 Kyiv venues have one).
 *
 * Runs AFTER the cap, so it is bounded by `VENUE_CHANGE_CATALOG_LIMIT` rather
 * than by the size of the city's catalog, and every result is cached by place
 * id — a second board open, for this pair or any other, costs nothing.
 *
 * Best-effort throughout: a venue whose lookup fails keeps its empty array and
 * the Mini App draws the category glyph it already draws today. Photos are
 * decoration; they must never be able to fail a board.
 */
async function withCuratedPhotos(venues: CatalogVenue[]): Promise<CatalogVenue[]> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) return venues;

  const now = Date.now();
  const pending = venues.filter(
    (v) => v.photoRefs.length === 0 && v.placeId && !isFreshInPhotoCache(v.placeId, now),
  );

  // Distinct ids only — the same place can legitimately appear once per board,
  // but this also protects against a future caller passing an un-deduped list.
  const ids = [...new Set(pending.map((v) => v.placeId as string))];
  await mapWithConcurrency(ids, PHOTO_LOOKUP_CONCURRENCY, async (placeId) => {
    await lookupAndCachePhotos(apiKey, placeId);
  });

  return venues.map((v) => {
    if (v.photoRefs.length > 0 || !v.placeId) return v;
    const hit = photoCache.get(v.placeId);
    return hit && hit.refs.length > 0 ? { ...v, photoRefs: hit.refs } : v;
  });
}

/**
 * One Place Details lookup, written into the shared cache. Never throws.
 *
 * **Only a non-empty answer earns the day-long TTL.** An empty one is held for
 * `PHOTO_CACHE_FAILURE_TTL_MS` like an outright failure, because the two are
 * indistinguishable from the response: "this place has no photos" is expressed
 * as an absent `photos` field, which is also what a partial 200 looks like. The
 * old code trusted the array and cached it for 24h, so a single such answer
 * blanked a venue for a day — silently, since a 200 logs nothing and the client
 * draws its category glyph without ever calling the photo proxy. Measured in the
 * demo (2026-08-15): the long-running process served one Kyiv venue with zero
 * refs while a fresh process resolved six for it in the same minute and Google
 * answered 20/20 with photos; a restart put it back to 12/12. That is the whole
 * failure — it never reaches the proxy, so the 2026-08-08 retry cannot see it.
 *
 * The cost of the short TTL is one Place Details call per genuinely photo-less
 * venue per 5 minutes, and only while someone has the board open — the catalog
 * is fetched on open, not on the ~4s state poll.
 */
async function lookupAndCachePhotos(apiKey: string, placeId: string): Promise<string[]> {
  const refs = await fetchPlacePhotoNames(apiKey, placeId, VENUE_CHANGE_PHOTOS_PER_VENUE);
  const found = refs != null && refs.length > 0;
  if (refs != null && refs.length === 0) {
    // Never silent, for the same reason the photo proxy stopped being silent:
    // a systematic empty (a field-mask change, a quota, a stale place id) is
    // otherwise indistinguishable from "this venue just has no pictures".
    console.warn(`[venue-change] photo lookup for ${placeId} returned no photos`);
  }
  photoCache.set(placeId, {
    refs: refs ?? [],
    expiresAt: Date.now() + (found ? PHOTO_CACHE_TTL_MS : PHOTO_CACHE_FAILURE_TTL_MS),
  });
  return refs ?? [];
}

/**
 * Photos for ONE place, through the same cache the catalog fills.
 *
 * The board's pinned "keep this place" card is not a catalog row — the assigned
 * venue is deliberately excluded from the alternatives — so it cannot inherit
 * the batch lookup above and needs its own way in. Callers that already hold a
 * stored cover should prefer it and reach for this only when they have none:
 * the board state is polled every ~4s, and this is a network call.
 *
 * Best-effort like everything else in this file: no key, no place id, or a
 * failed lookup all resolve to an empty list and the client draws its glyph.
 */
export async function resolveVenuePhotoRefs(placeId: string | null): Promise<string[]> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey || !placeId) return [];
  if (!isFreshInPhotoCache(placeId, Date.now())) return lookupAndCachePhotos(apiKey, placeId);
  return photoCache.get(placeId)?.refs ?? [];
}

function isFreshInPhotoCache(placeId: string, now: number): boolean {
  const hit = photoCache.get(placeId);
  return hit != null && hit.expiresAt > now;
}

/** Bounded parallel map — same shape as `workers/embedding-refresh.ts`. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  });
  await Promise.all(workers);
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
  // Before the cap, so dropping it frees a slot for a real alternative rather
  // than spending one on the venue the pair already has.
  const alternatives = withoutCurrentVenue(chosen, input.excludeVenue);
  const capped = capCatalog(alternatives, input.seed);
  return input.withPhotos ? withCuratedPhotos(capped) : capped;
}

/** Drop the currently-assigned venue — see `BuildCatalogInput.excludeVenue`. */
function withoutCurrentVenue(
  venues: CatalogVenue[],
  current: BuildCatalogInput["excludeVenue"],
): CatalogVenue[] {
  if (!current) return venues;
  return venues.filter((v) => {
    // A place id is authoritative when both sides have one. Otherwise fall back
    // to name + address, the same identity `venueKeyOf` uses.
    if (current.placeId && v.placeId) return v.placeId !== current.placeId;
    return !(v.name === current.name && v.address === current.address);
  });
}

/** FNV-1a → 32-bit seed. Small, stable, and dependency-free. */
function hashSeed(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, enough for shuffling a 12-card list. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against a seeded PRNG — same seed, same order, every fetch. */
function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = [...items];
  const rand = seededRandom(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Slots held for an open-air walking spot, whatever the distance ordering
 * would otherwise have done with them (§3.7b — "the board is never all
 * indoors"). Founder decision 2026-08-09.
 *
 * Without a reservation the board is decided purely by proximity, and in a city
 * centre that means cafés: measured against the live Kyiv catalog, **38% of
 * possible boards carried no outdoor spot at all** and the rest averaged one
 * card (the board held twelve then) — while the median board centre had **ten** parks sitting
 * inside the same 3 km radius. So they were never out of reach, they were
 * losing a race they cannot win: a promenade is one venue over a kilometre of
 * riverfront, a cafe cluster is thirty doors on one street.
 *
 * Five since the board widened 12 → 21 (was three), and the re-measurement is
 * what forced it: simulating both caps over every Kyiv centre, a bare widening
 * left the average outdoor count flat at ~2.6 cards, i.e. all nine new slots
 * went to cafés and restaurants — the precise failure this reservation exists
 * to prevent, reappearing because the floor is absolute while the board around
 * it grew. At five it comes back to ~4.2. Still nearly always fillable (81% of
 * centres have at least five parks inside `VENUE_CHANGE_RADIUS_KM`, against
 * 84% for three; the median centre has ten), and still a FLOOR, not a cap: an
 * outdoor spot that would have earned a slot on distance still takes one, so a
 * green district shows more than five.
 */
export const VENUE_CHANGE_WALK_RESERVED = 5;

/**
 * What counts as somewhere to walk rather than somewhere to sit.
 *
 * Deliberately the `park` category alone. It is what the curated base actually
 * uses for the whole open-air set — parks, embankments, the Andriivskyi
 * descent, Volodymyrska Hirka, the Lovers' Bridge — and every one of them is
 * free to enter, needs no booking and works as a place to meet at a time you
 * choose. Ticketed, timed venues are a different product answer and stay out:
 * `museum` is excluded from this board outright (`EXCLUDED_VENUE_CATEGORIES`),
 * and this reservation does not reopen that door.
 */
function isWalkingSpot(venue: CatalogVenue): boolean {
  return venue.category === "park";
}

/**
 * Board ordering (§Premium upsell, §3.7b):
 *
 *   1. The `VENUE_CHANGE_PREMIUM_PINNED` nearest premium venues lead the list,
 *      unconditionally — the locked tier is the first thing a non-subscriber
 *      sees, which is the whole conversion mechanic.
 *   2. Any premium past that (up to `VENUE_CHANGE_PREMIUM_MAX` total) is
 *      **scattered** through the remainder rather than stacked on top, so the
 *      board reads as a mixed choice instead of a paywall wall — a locked card
 *      keeps turning up as the user scrolls.
 *   3. `VENUE_CHANGE_WALK_RESERVED` of the remaining slots are held for the
 *      nearest outdoor walking spots, so the board is never a wall of tables.
 *   4. The rest of the slots go to the nearest non-premium (base +
 *      alternative), and the whole tail is shuffled together.
 *
 * Step 3 changes only WHICH cards make the cut, never where they sit: the
 * reserved spots go into the same shuffled tail as everything else, because the
 * point is that at least one is on the board at all, not that it leads. That is
 * the opposite of the premium pin above, which exists precisely to own the top.
 *
 * The shuffle is seeded by `seed` (the match id), so the order is stable across
 * re-fetches — without that the cards would re-deal on every catalog load. With
 * no seed it degrades to plain distance order. Places-fallback rows are always
 * `tier: "base"`, and that sweep already searches `park`, so it gets the same
 * guarantee for free.
 */
export function capCatalog(venues: CatalogVenue[], seed?: string): CatalogVenue[] {
  const byDistance = (a: CatalogVenue, b: CatalogVenue): number => a.distanceKm - b.distanceKm;
  const premium = venues
    .filter((v) => v.tier === "premium")
    .sort(byDistance)
    .slice(0, VENUE_CHANGE_PREMIUM_MAX);
  const pinned = premium.slice(0, VENUE_CHANGE_PREMIUM_PINNED);
  const scattered = premium.slice(VENUE_CHANGE_PREMIUM_PINNED);
  const tailSlots = Math.max(0, VENUE_CHANGE_CATALOG_LIMIT - pinned.length - scattered.length);

  const nonPremium = venues.filter((v) => v.tier !== "premium").sort(byDistance);
  // Claimed first so a dense indoor cluster cannot spend the slots before the
  // outdoor ones are considered. Fewer in range than reserved simply yields
  // fewer — the board degrades to today's behaviour rather than shrinking.
  const reserved = nonPremium
    .filter(isWalkingSpot)
    .slice(0, Math.min(VENUE_CHANGE_WALK_RESERVED, tailSlots));
  const claimed = new Set(reserved);
  // Not `filter(!isWalkingSpot)`: an outdoor spot beyond the reservation is an
  // ordinary candidate and still competes on distance, which is what makes the
  // rule a floor rather than a quota capping how many can appear.
  const rest = nonPremium
    .filter((v) => !claimed.has(v))
    .slice(0, Math.max(0, tailSlots - reserved.length));

  const tail = [...scattered, ...reserved, ...rest];
  return [...pinned, ...(seed ? seededShuffle(tail, seed) : tail)];
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
