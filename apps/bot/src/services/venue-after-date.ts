import { prisma, Prisma } from "@gennety/db";
import type { RhythmActivity } from "@gennety/shared";

import { haversineDistanceKm } from "./geo.js";

/**
 * The post-date scenario of Tempo Sync Tier 2 (decision journal 2026-09-24):
 * "if you feel like keeping going, there is X a few minutes away".
 *
 * Only ever chosen when the pair's lead rhythm leans somewhere — a park for an
 * active lead, a café for a calm one; a moderate or unknown lead gets nothing,
 * which is the ТЗ's universal default. The wording on every client is the SAME
 * for both kinds and never says why: the partner sees the place too, and "a
 * park, because you are active" would be exactly the disclosure the fence
 * exists to prevent. So the row stores the place and the venue it belongs to,
 * and not the kind.
 */

/** Straight-line radius around the date venue; ~11 minutes on foot. */
export const AFTER_DATE_RADIUS_M = 900;
/** The date is assumed to last this long: the place must be open by then. */
export const AFTER_DATE_OFFSET_MIN = 90;
/** Walking pace used for the minutes shown to the person. */
export const WALK_M_PER_MIN = 80;

export type AfterDateKind = "stroll" | "treat";

/** What the lead rhythm asks the continuation to be, or null for nothing. */
export function afterDateKindFor(lead: RhythmActivity | null): AfterDateKind | null {
  if (lead === "active") return "stroll";
  if (lead === "calm") return "treat";
  return null;
}

const CATEGORIES: Record<AfterDateKind, readonly string[]> = {
  stroll: ["park"],
  treat: ["cafe", "coffee_shop"],
};

/** Stored on `Match.afterDatePlace`. `forVenuePlaceId` ties it to the venue. */
export interface StoredAfterDatePlace {
  forVenuePlaceId: string;
  placeId: string | null;
  name: string;
  lat: number;
  lng: number;
  walkMinutes: number;
}

/** What a client is served — nothing about why. */
export interface AfterDatePlaceView {
  name: string;
  lat: number;
  lng: number;
  walkMinutes: number;
}

/**
 * "Is this row open at that moment?" — `hoursEvidenceAdmits` from the venue
 * selector, passed in rather than imported so this module and the selector
 * that calls it do not import each other.
 */
export type OpenAt = (row: AfterDateCandidateRow, at: Date) => boolean;

export interface AfterDateCandidateRow {
  id: string;
  placeId: string | null;
  name: string;
  lat: number;
  lng: number;
  category: string;
  priority: number;
  hoursConfidence: string | null;
  openingHours: unknown;
  utcOffsetMinutes: number | null;
}

/**
 * Pure pick: the nearest row of the right kind inside the radius that is open
 * when the date ends, excluding the date venue itself. Ties go to the catalog's
 * own priority.
 */
export function pickAfterDatePlace(
  kind: AfterDateKind,
  venue: { placeId: string; lat: number; lng: number },
  rows: readonly AfterDateCandidateRow[],
  dateEnd: Date,
  openAt: OpenAt,
): StoredAfterDatePlace | null {
  const categories = CATEGORIES[kind];
  const scored = rows
    .filter((row) => categories.includes(row.category))
    .filter((row) => (row.placeId ?? `curated:${row.id}`) !== venue.placeId)
    .map((row) => ({ row, meters: haversineDistanceKm(venue, row) * 1000 }))
    .filter(({ meters }) => meters <= AFTER_DATE_RADIUS_M)
    .filter(({ row }) => openAt(row, dateEnd))
    .sort((left, right) => left.meters - right.meters || left.row.priority - right.row.priority);
  const best = scored[0];
  if (!best) return null;
  return {
    forVenuePlaceId: venue.placeId,
    placeId: best.row.placeId,
    name: best.row.name,
    lat: best.row.lat,
    lng: best.row.lng,
    walkMinutes: Math.max(1, Math.ceil(best.meters / WALK_M_PER_MIN)),
  };
}

/**
 * Find the continuation for a just-chosen venue. Returns null for a lead that
 * asks for nothing, and on any failure — a missing suggestion must never cost
 * the pair their date.
 */
export async function findAfterDatePlace(input: {
  lead: RhythmActivity | null;
  venue: { placeId: string; lat: number; lng: number };
  cityKey: string | null;
  agreedTime: Date;
  openAt: OpenAt;
}): Promise<StoredAfterDatePlace | null> {
  const kind = afterDateKindFor(input.lead);
  if (!kind) return null;
  // A box a little wider than the radius; the exact check is `haversine`.
  const dLat = (AFTER_DATE_RADIUS_M * 1.2) / 111_320;
  const dLng = dLat / Math.max(0.2, Math.cos((input.venue.lat * Math.PI) / 180));
  try {
    const rows = await prisma.curatedVenue.findMany({
      where: {
        active: true,
        category: { in: [...CATEGORIES[kind]] },
        ...(input.cityKey ? { cityKey: input.cityKey } : {}),
        lat: { gte: input.venue.lat - dLat, lte: input.venue.lat + dLat },
        lng: { gte: input.venue.lng - dLng, lte: input.venue.lng + dLng },
      },
      select: {
        id: true,
        placeId: true,
        name: true,
        lat: true,
        lng: true,
        category: true,
        priority: true,
        hoursConfidence: true,
        openingHours: true,
        utcOffsetMinutes: true,
      },
      take: 200,
    });
    const dateEnd = new Date(input.agreedTime.getTime() + AFTER_DATE_OFFSET_MIN * 60_000);
    return pickAfterDatePlace(kind, input.venue, rows, dateEnd, input.openAt);
  } catch (error) {
    console.warn("[after-date] lookup failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Prisma write value for the column. */
export function afterDatePlaceWrite(
  place: StoredAfterDatePlace | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return place ? (place as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}

/**
 * The client view, served only while the match still points at the venue the
 * suggestion was chosen for — a venue change (or any later re-selection)
 * silently retires it without every writer having to remember this column.
 */
export function afterDatePlaceView(
  stored: unknown,
  currentVenuePlaceId: string | null,
): AfterDatePlaceView | null {
  if (!stored || typeof stored !== "object" || !currentVenuePlaceId) return null;
  const value = stored as Partial<StoredAfterDatePlace>;
  if (value.forVenuePlaceId !== currentVenuePlaceId) return null;
  if (
    typeof value.name !== "string" ||
    typeof value.lat !== "number" ||
    typeof value.lng !== "number" ||
    typeof value.walkMinutes !== "number"
  ) {
    return null;
  }
  return { name: value.name, lat: value.lat, lng: value.lng, walkMinutes: value.walkMinutes };
}
