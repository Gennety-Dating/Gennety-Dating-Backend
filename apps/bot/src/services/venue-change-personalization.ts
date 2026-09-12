import { prisma } from "@gennety/db";

import { haversineDistanceKm } from "./geo.js";
import { readFrequentPlaces } from "./frequent-places.js";

/**
 * Personal ordering of the venue-change board (2026-09-12, founder's call).
 *
 * The board's alternatives are chosen by the pair's situation — everything
 * within `VENUE_CHANGE_RADIUS_KM` of the venue they were given, gated on hours
 * and quality, capped and scattered from the match id. This module does not
 * touch any of that. It reorders what that selection produced, per viewer,
 * from what we already know about where that person actually goes.
 *
 * ── The invariant this module must never break ──────────────────────────
 *
 * **The SET is identical for both participants; only the ORDER is personal.**
 * A change of venue happens when the two sides' hearts intersect. If
 * personalisation could add or drop a card, one person could heart a venue the
 * other has never been shown, and the intersection — the entire mechanic —
 * would silently stop being reachable. So this takes an array and returns a
 * permutation of it: same length, same members, every time.
 *
 * That is also why personalisation cannot reach past the cap to surface a
 * venue that did not make the selection. It is a real limit, and it is the
 * right side of the trade: a board where I can pick what you cannot see is
 * broken in a way a slightly worse ordering is not.
 *
 * ── What "personal" is made of ─────────────────────────────────────────
 *
 * Two signals, both already collected and both already consented to:
 *
 *   - **Affinity** — how close the venue is to the places this person actually
 *     frequents (`user_place_visits`, the opt-in frequent-places block). This
 *     is the brief's "near their usual hubs": proximity to where they already
 *     are, not the identity of a café they already sit in.
 *   - **Novelty** — whether they have already been taken there by us
 *     (`UserScratchMap.discoveredVenues`, written when a Date Bump verifies a
 *     couple at a venue). A CHANGE of venue that offers the place you were
 *     last taken to is the one suggestion the feature exists to avoid, so
 *     having been there is a penalty rather than a boost.
 *
 * ── Why it can only nudge ──────────────────────────────────────────────
 *
 * The base order encodes operator priority, rating, having a photograph and
 * distance from the agreed venue — the things that make a place a good first
 * date at all. Affinity says only that somebody walks past it a lot. So the
 * base position carries the most weight, and the personal signals move a venue
 * a few places rather than to the top: `AFFINITY_WEIGHT` and `SEEN_PENALTY`
 * are both well under the full span of the base score.
 *
 * ── When it does nothing ───────────────────────────────────────────────
 *
 * Opted out, no visits recorded, location never granted, a city we have no
 * catalog for — every one of those ends in the same place: the input order,
 * returned untouched. There is no degraded ordering and no second ranking to
 * keep in step; the feature simply is not there, which is what makes the
 * permission state safe to be in.
 */

/** Just enough of a board venue to rank it. */
export interface RankableVenue {
  placeId: string | null;
  lat: number;
  lng: number;
}

/** One place the viewer actually goes, with the weight it earned. */
export interface AffinityAnchor {
  lat: number;
  lng: number;
  /** Distinct days visited inside the frequent-places window. */
  visits: number;
}

/** Everything personal about one viewer, resolved once per catalog call. */
export interface ViewerAffinity {
  anchors: AffinityAnchor[];
  /** Place ids a Date Bump has already verified this person at. */
  beenThere: ReadonlySet<string>;
}

/** Nothing known about this viewer — ranking is then the identity function. */
export const NO_AFFINITY: ViewerAffinity = { anchors: [], beenThere: new Set() };

/**
 * Distance at which an anchor's pull has fallen to ~37 %.
 *
 * 700 m is about a ten-minute walk, which is the honest span of "near a place
 * I go". Much larger and every venue inside the 3 km ring scores the same, so
 * the signal stops separating anything; much smaller and only a venue on the
 * same corner counts, which the base ordering already knew.
 */
const AFFINITY_DECAY_KM = 0.7;

/**
 * How much the whole personal layer may move a venue, as a fraction of the
 * base score's full span (base runs 1 → 0 across the list). At 0.45 a venue
 * with perfect affinity climbs past roughly the nearer half of what separated
 * it from the top — enough to be visible, never enough to put a poor venue
 * first.
 */
const AFFINITY_WEIGHT = 0.45;

/** Having already been taken there costs about a third of the list's span. */
const SEEN_PENALTY = 0.35;

/**
 * A visit count past this adds nothing more.
 *
 * Without a cap, one person's daily café would out-weigh every other anchor
 * combined and the board would orbit a single street. The window is 180 days,
 * so 12 distinct days is already "this is my place".
 */
const VISITS_CAP = 12;

/**
 * Pull of one anchor on one venue: its weight, decayed by distance.
 *
 * Exponential rather than a radius test, because a cliff edge would make the
 * ordering jump for a step of one metre — and the whole list is re-ranked on
 * every poll of the board.
 */
function anchorPull(venue: RankableVenue, anchor: AffinityAnchor): number {
  const km = haversineDistanceKm(
    { lat: venue.lat, lng: venue.lng },
    { lat: anchor.lat, lng: anchor.lng },
  );
  if (!Number.isFinite(km)) return 0;
  const weight = Math.min(anchor.visits, VISITS_CAP) / VISITS_CAP;
  return weight * Math.exp(-km / AFFINITY_DECAY_KM);
}

/**
 * How near this venue is to where the viewer actually goes, in [0..1].
 *
 * The strongest anchor wins rather than the sum: two cafés either side of one
 * venue mean the same "this is my area" as one does, and summing would let a
 * dense cluster of weak anchors beat the place someone genuinely lives at.
 */
export function affinityOf(venue: RankableVenue, anchors: readonly AffinityAnchor[]): number {
  let best = 0;
  for (const anchor of anchors) {
    const pull = anchorPull(venue, anchor);
    if (pull > best) best = pull;
  }
  return best;
}

/**
 * Reorder one board selection for one viewer.
 *
 * Pure, and a permutation by construction — it sorts indices and reads the
 * input array by them, so a member can be neither invented nor lost. Ties fall
 * back to the original position, so the result is stable and a poll that
 * changes nothing renders nothing moved.
 */
export function personalizeOrder<T extends RankableVenue>(
  venues: readonly T[],
  affinity: ViewerAffinity,
): T[] {
  if (venues.length < 2) return [...venues];
  if (affinity.anchors.length === 0 && affinity.beenThere.size === 0) return [...venues];

  const span = venues.length - 1;
  const scored = venues.map((venue, index) => {
    const base = 1 - index / span;
    const personal =
      AFFINITY_WEIGHT * affinityOf(venue, affinity.anchors) -
      (venue.placeId && affinity.beenThere.has(venue.placeId) ? SEEN_PENALTY : 0);
    return { index, score: base + personal };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => venues[entry.index]!);
}

/**
 * Where a Date Bump has verified this person, or null.
 *
 * Its own `async` function rather than a `.catch()` on the call, because a
 * throw while REACHING the query — a Prisma client that predates the model,
 * which is exactly what a half-migrated deploy looks like — is synchronous.
 * Inside `Promise.all([...])` that throw escapes before `Promise.all` is
 * called, abandoning the sibling promise unhandled; an async function turns it
 * into a rejection this `try` can actually see.
 */
async function readScratchMap(userId: string): Promise<{ discoveredVenues: string[] } | null> {
  try {
    return await prisma.userScratchMap.findUnique({
      where: { userId },
      select: { discoveredVenues: true },
    });
  } catch {
    return null;
  }
}

/**
 * Everything personal about one viewer, or `NO_AFFINITY` when there is nothing
 * to know. Never throws: a board that cannot be personalised is a board in its
 * ordinary order, not an error on a screen.
 */
export async function readViewerAffinity(userId: string): Promise<ViewerAffinity> {
  try {
    const [frequent, scratch] = await Promise.all([
      // Reads the opt-in itself and answers with an empty ranking when it is
      // off, so consent is enforced in one place rather than re-checked here.
      readFrequentPlaces(userId),
      readScratchMap(userId),
    ]);

    const beenThere = new Set(scratch?.discoveredVenues ?? []);

    // Hidden places are excluded deliberately. Hiding one is the owner saying
    // "do not show people this about me"; quietly steering their date towards
    // it would honour the letter of that and not the point.
    const shown = frequent.ranking.shown;
    if (shown.length === 0) return { anchors: [], beenThere };

    // The block carries no coordinates — it is a list of names — so the
    // catalog is what turns a place id back into a point on the map.
    const rows = await prisma.curatedVenue.findMany({
      where: { placeId: { in: shown.map((place) => place.placeId) } },
      select: { placeId: true, lat: true, lng: true },
    });
    const pointOf = new Map<string, { lat: number; lng: number }>();
    for (const row of rows) {
      if (!row.placeId || pointOf.has(row.placeId)) continue;
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
      pointOf.set(row.placeId, { lat: row.lat, lng: row.lng });
    }

    const anchors: AffinityAnchor[] = [];
    for (const place of shown) {
      const point = pointOf.get(place.placeId);
      if (!point) continue;
      anchors.push({ lat: point.lat, lng: point.lng, visits: place.visits });
    }
    return { anchors, beenThere };
  } catch (err) {
    console.error("[venue-change] affinity unavailable — serving base order:", err);
    return NO_AFFINITY;
  }
}
