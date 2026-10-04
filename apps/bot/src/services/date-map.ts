import { prisma } from "@gennety/db";
import { mapVibeTagsToFacets, type VenueExperience } from "@gennety/shared";

import { venueCoordinatesOf } from "./venue-location.js";

/**
 * The date map (docs/product/domains/living-canvas.md §6.5): the places this
 * person has actually been on a date, and nothing else.
 *
 * It replaces the Scratch Map's city fog (retired 2026-10-02). The fog was a
 * background tracker with no date in it — a percentage of Kyiv that grew while
 * someone walked to class — and that is the opposite of what the map is for.
 *
 * **Derived, never stored.** A place is on the map because a `Match` row says
 * this side attended a date there (`dateAttended{A,B}`, written by a verified
 * Date Bump or by the attendance flow). There is no second table to keep in
 * step with the match, no consent of its own — it collects nothing the date
 * did not already hold — and no user coordinate anywhere: the only point is
 * the VENUE's, and only on rows where `venueLat/Lng` means the venue rather
 * than the legacy route midpoint.
 *
 * The partner is deliberately absent. The map answers "where have I been on a
 * date", never "with whom".
 */

/** Statuses a held date can be in. A cancelled or expired row never happened. */
const HELD_STATUSES = ["scheduled", "completed"] as const;

/** How many vibes the profile shows — a summary, not a census. */
export const DATE_MAP_TOP_VIBES = 3;

export interface DateMapPlace {
  /** Google place id when the venue has one, else null (legacy domain path). */
  placeId: string | null;
  name: string;
  /** The VENUE's point, or null on a legacy midpoint row. */
  lat: number | null;
  lng: number | null;
  visits: number;
  lastDateAt: Date;
  experiences: VenueExperience[];
}

export interface DateMapVibe {
  experience: VenueExperience;
  /** Confirmed dates spent at a place with this experience. */
  dates: number;
}

export interface DateMap {
  confirmedDates: number;
  /** Most recent first. */
  places: DateMapPlace[];
  /** Most frequent first, at most `DATE_MAP_TOP_VIBES`. */
  vibes: DateMapVibe[];
}

interface AttendedDate {
  id: string;
  agreedTime: Date;
  venueName: string | null;
  venuePlaceId: string | null;
  venueLat: number | null;
  venueLng: number | null;
  venueMidpointLat: number | null;
}

/**
 * Every held date this side attended, newest first.
 *
 * Attendance is per side on purpose: one partner's verified presence says
 * nothing about where the other one was.
 */
async function attendedDates(userId: string, now: Date): Promise<AttendedDate[]> {
  const rows = await prisma.match.findMany({
    where: {
      status: { in: [...HELD_STATUSES] },
      agreedTime: { lte: now },
      OR: [
        { userAId: userId, dateAttendedA: true },
        { userBId: userId, dateAttendedB: true },
      ],
    },
    orderBy: { agreedTime: "desc" },
    select: {
      id: true,
      agreedTime: true,
      venueName: true,
      venuePlaceId: true,
      venueLat: true,
      venueLng: true,
      venueMidpointLat: true,
    },
  });
  // The `lte` above already excludes a null time; this narrows the type.
  return rows.filter((row): row is AttendedDate => row.agreedTime !== null);
}

/**
 * Group dates by place and keep the order they arrived in.
 *
 * A venue without a place id is keyed by name: a legacy row names the place
 * and nothing else, and two dates at "Kyivska Perepichka" are the same place
 * on any map a person would draw.
 */
export function groupPlaces(
  dates: readonly Omit<AttendedDate, "id">[],
  tagsByPlaceId: ReadonlyMap<string, readonly string[]>,
): DateMapPlace[] {
  const byKey = new Map<string, DateMapPlace>();
  for (const date of dates) {
    const name = date.venueName?.trim();
    if (!name) continue;
    const key = date.venuePlaceId ? `place:${date.venuePlaceId}` : `name:${name.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.visits += 1;
      continue;
    }
    const point = venueCoordinatesOf(date);
    const tags = date.venuePlaceId ? tagsByPlaceId.get(date.venuePlaceId) ?? [] : [];
    byKey.set(key, {
      placeId: date.venuePlaceId,
      name,
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      visits: 1,
      lastDateAt: date.agreedTime,
      experiences: mapVibeTagsToFacets(tags).experiences,
    });
  }
  return [...byKey.values()];
}

/** Experiences weighted by dates spent there, ties in catalog order. */
export function topVibes(places: readonly DateMapPlace[]): DateMapVibe[] {
  const counts = new Map<VenueExperience, number>();
  for (const place of places) {
    for (const experience of place.experiences) {
      counts.set(experience, (counts.get(experience) ?? 0) + place.visits);
    }
  }
  return [...counts.entries()]
    .map(([experience, dates]) => ({ experience, dates }))
    .sort((a, b) => b.dates - a.dates)
    .slice(0, DATE_MAP_TOP_VIBES);
}

/**
 * Vibe tags per place id, unioned across the catalog's per-domain copies of
 * the same place (one Google place can sit under several universities).
 */
async function tagsFor(placeIds: readonly string[]): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>();
  if (placeIds.length === 0) return tags;
  const rows = await prisma.curatedVenue.findMany({
    where: { placeId: { in: [...placeIds] } },
    select: { placeId: true, vibeTags: true },
  });
  for (const row of rows) {
    if (!row.placeId) continue;
    const merged = new Set([...(tags.get(row.placeId) ?? []), ...row.vibeTags]);
    tags.set(row.placeId, [...merged]);
  }
  return tags;
}

export async function readDateMap(userId: string, now: Date = new Date()): Promise<DateMap> {
  return (await readDateHistory(userId, now)).map;
}

/** One confirmed date, as the Profiler's contextual questions refer to it. */
export interface ConfirmedDate {
  matchId: string;
  at: Date;
  venueName: string | null;
}

/**
 * The date map plus the dates it was built from, newest first — for the
 * Profiler's contextual questions, which ask about one particular date
 * ("same format next time?") and about the map's leading experience. Same
 * query, same attendance rule, so the questions can never see a date the map
 * would not show.
 */
export async function readDateHistory(
  userId: string,
  now: Date = new Date(),
): Promise<{ dates: ConfirmedDate[]; map: DateMap }> {
  const dates = await attendedDates(userId, now);
  const placeIds = [
    ...new Set(dates.map((date) => date.venuePlaceId).filter((id): id is string => !!id)),
  ];
  const places = groupPlaces(dates, await tagsFor(placeIds));
  return {
    dates: dates.map((date) => ({
      matchId: date.id,
      at: date.agreedTime,
      venueName: date.venueName?.trim() || null,
    })),
    map: { confirmedDates: dates.length, places, vibes: topVibes(places) },
  };
}

/**
 * Place ids this person has had a confirmed date at — the venue-change
 * board's "you have been here" signal.
 *
 * Never throws: a board that cannot be personalised is a board in its ordinary
 * order, not an error on a screen. Its own `async` function so a synchronous
 * throw while reaching the query becomes a rejection the `try` can see.
 */
export async function readAttendedPlaceIds(userId: string): Promise<Set<string>> {
  try {
    const dates = await attendedDates(userId, new Date());
    return new Set(dates.map((date) => date.venuePlaceId).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}
