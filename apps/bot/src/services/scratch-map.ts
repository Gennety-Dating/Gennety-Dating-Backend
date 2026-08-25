import { prisma } from "@gennety/db";
import {
  DEFAULT_MARKET,
  distanceKm,
  findMarketByCityKey,
  isTile,
  tileBounds,
  tileFor,
  type Market,
} from "@gennety/shared";

/**
 * The Dating Scratch Map (PRODUCT_SPEC §Scratch Map): which parts of the city
 * this person has actually been in, at neighbourhood resolution.
 *
 * **The privacy design lives in `@gennety/shared/geohash`, not here** — a tile
 * is ~1.2 km × 0.61 km, so nothing narrower than a neighbourhood is
 * representable at all. What this module owns is the other half of the
 * promise: WHEN a tile may be written.
 *
 * Two gates, and both are structural rather than remembered:
 *
 *   1. `User.scratchMapOptIn` is its own column, not a fold into
 *      `researchOptIn`. That one governs analytics use of data we already
 *      hold; this one authorises COLLECTING a new class of it, and a consent
 *      that authorises new collection is never inferred from a broader tick —
 *      the same rule `biometricConsentAt` follows.
 *   2. Every write comes from the foreground: a ping while the canvas is open,
 *      or a verified Date Bump. There is no background-location entitlement in
 *      the iOS app and no such permission requested in the Mini App, so the
 *      "nothing is recorded while you are not looking" promise is a property
 *      of what exists rather than of this file.
 */

/** Refusals a caller can act on. Anything else is a 500. */
export type ScratchRefusal =
  | "opted-out"
  | "outside-market"
  | "bad-coordinates";

export interface ScratchState {
  exploredTiles: string[];
  exploredPercent: number;
  discoveredVenues: string[];
}

export interface ScratchPingResult {
  state: ScratchState;
  /** Whether this ping uncovered ground the user had not been on before. */
  uncovered: boolean;
}

/**
 * How many tiles a market holds, counted once per city and cached.
 *
 * The denominator has to be a constant of the CITY rather than of the data:
 * deriving it from tiles anyone has visited would make everyone's percentage
 * move whenever a stranger walked somewhere new, and a person who explored
 * nothing new would watch their own number fall.
 *
 * A tile counts when its centre is inside the market radius — the same circle
 * `marketForCoordinates` and the departure-point gate use, so "explored" and
 * "allowed to set off from" describe the same city.
 */
const tileCounts = new Map<string, number>();

export function tilesInMarket(market: Market): number {
  const cached = tileCounts.get(market.cityKey);
  if (cached !== undefined) return cached;

  // A tile is taller in latitude than it is wide in longitude at this
  // precision, so the walk steps by the real cell size rather than a guess:
  // too coarse a step skips cells, too fine only costs a few thousand
  // iterations once per process.
  const probe = tileBounds(tileFor(market.latitude, market.longitude)!)!;
  const latStep = probe.maxLat - probe.minLat;
  const lngStep = probe.maxLng - probe.minLng;

  const latSpan = market.radiusKm / 111.32;
  const lngSpan =
    market.radiusKm / (111.32 * Math.cos((market.latitude * Math.PI) / 180));

  const seen = new Set<string>();
  for (let lat = market.latitude - latSpan; lat <= market.latitude + latSpan; lat += latStep / 2) {
    for (let lng = market.longitude - lngSpan; lng <= market.longitude + lngSpan; lng += lngStep / 2) {
      const tile = tileFor(lat, lng);
      if (!tile || seen.has(tile)) continue;
      const bounds = tileBounds(tile)!;
      const centreLat = (bounds.minLat + bounds.maxLat) / 2;
      const centreLng = (bounds.minLng + bounds.maxLng) / 2;
      if (distanceKm(market.latitude, market.longitude, centreLat, centreLng) <= market.radiusKm) {
        seen.add(tile);
      }
    }
  }

  // A market that somehow encloses nothing must not divide by zero and hand
  // every user a percentage of Infinity.
  const total = Math.max(1, seen.size);
  tileCounts.set(market.cityKey, total);
  return total;
}

/** `[0..1]`, clamped: a user with more tiles than the city has is at 100%. */
export function percentFor(tiles: readonly string[], market: Market): number {
  return Math.min(1, tiles.length / tilesInMarket(market));
}

/**
 * Fold a tile into a set, keeping it sorted and unique.
 *
 * Postgres arrays enforce neither, and a duplicate would silently inflate
 * `exploredPercent` — the one number on this row a person actually reads.
 */
export function addTile(tiles: readonly string[], tile: string): string[] {
  if (tiles.includes(tile)) return [...tiles];
  return [...tiles, tile].sort();
}

const EMPTY: ScratchState = { exploredTiles: [], exploredPercent: 0, discoveredVenues: [] };

export async function readScratchMap(userId: string): Promise<ScratchState> {
  const row = await prisma.userScratchMap.findUnique({
    where: { userId },
    select: { exploredTiles: true, exploredPercent: true, discoveredVenues: true },
  });
  return row ?? EMPTY;
}

/**
 * Record one foreground ping.
 *
 * The coordinates are used to pick a tile and then dropped — they are never
 * stored and never logged, the same rule the Date Radar follows.
 */
export async function recordScratchPing(input: {
  userId: string;
  lat: number;
  lng: number;
}): Promise<ScratchPingResult | { refused: ScratchRefusal }> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      scratchMapOptIn: true,
      profile: { select: { homeCityKey: true } },
    },
  });
  if (!user?.scratchMapOptIn) return { refused: "opted-out" };

  const tile = tileFor(input.lat, input.lng);
  if (!tile) return { refused: "bad-coordinates" };

  // A traveller's tiles belong to the city they live in, not to wherever they
  // happen to be: the map is "your Kyiv", and a week in Berlin would otherwise
  // fill it with squares that no percentage of Kyiv can describe.
  const market = findMarketByCityKey(user.profile?.homeCityKey) ?? DEFAULT_MARKET;
  if (distanceKm(market.latitude, market.longitude, input.lat, input.lng) > market.radiusKm) {
    return { refused: "outside-market" };
  }

  const existing = await readScratchMap(input.userId);
  const tiles = addTile(existing.exploredTiles, tile);
  if (tiles.length === existing.exploredTiles.length) {
    // Nothing new. The common case by far — the canvas pings while someone
    // sits still — so it costs one read and no write.
    return { state: existing, uncovered: false };
  }

  const percent = percentFor(tiles, market);
  const row = await prisma.userScratchMap.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      exploredTiles: tiles,
      exploredPercent: percent,
    },
    update: { exploredTiles: tiles, exploredPercent: percent },
    select: { exploredTiles: true, exploredPercent: true, discoveredVenues: true },
  });

  return { state: row, uncovered: true };
}

/**
 * A verified Date Bump: the pair was observably at the venue, so both sides
 * get its tile and the venue itself.
 *
 * This is the one write that is not a ping, and it is allowed for the same
 * reason the Bump may write `dateAttended*` while the evidence classifier may
 * not: it is not a guess about where someone was. Two people deliberately
 * shook their phones, at the place, at the time.
 *
 * Best-effort by construction — it is called from the bump's own success path,
 * and a scratch map that misses a square must never cost someone the date
 * their reliability and bonus ticket ride on.
 */
export async function recordVerifiedVisit(input: {
  userIds: readonly string[];
  venueId: string | null;
  lat: number | null;
  lng: number | null;
}): Promise<void> {
  for (const userId of input.userIds) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          scratchMapOptIn: true,
          profile: { select: { homeCityKey: true } },
        },
      });
      if (!user?.scratchMapOptIn) continue;

      const existing = await readScratchMap(userId);
      const market = findMarketByCityKey(user.profile?.homeCityKey) ?? DEFAULT_MARKET;

      let tiles = existing.exploredTiles;
      if (input.lat != null && input.lng != null) {
        const tile = tileFor(input.lat, input.lng);
        if (tile) tiles = addTile(tiles, tile);
      }

      const venues =
        input.venueId && !existing.discoveredVenues.includes(input.venueId)
          ? [...existing.discoveredVenues, input.venueId]
          : existing.discoveredVenues;

      const unchanged =
        tiles.length === existing.exploredTiles.length &&
        venues.length === existing.discoveredVenues.length;
      if (unchanged) continue;

      await prisma.userScratchMap.upsert({
        where: { userId },
        create: {
          userId,
          exploredTiles: tiles,
          exploredPercent: percentFor(tiles, market),
          discoveredVenues: venues,
        },
        update: {
          exploredTiles: tiles,
          exploredPercent: percentFor(tiles, market),
          discoveredVenues: venues,
        },
      });
    } catch (err) {
      console.error("[scratch-map] verified visit failed for", userId, err);
    }
  }
}

/** Whitelist for the settings toggle. */
export function isValidTileList(tiles: readonly string[]): boolean {
  return tiles.every(isTile);
}
