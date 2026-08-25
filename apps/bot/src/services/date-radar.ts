/**
 * Date Radar — the last forty-five minutes before a date (PRODUCT_SPEC §6.3).
 *
 * Each side's phone pings its own position; each side is told, about the
 * other, **one sentence and nothing else**: "on the way, arriving 18:55", or
 * "here". Never a position, never a distance, never an address.
 *
 * ── Why nothing is stored ───────────────────────────────────────────────
 *
 * There is no schema for any of this, deliberately. Every other geographic
 * column in the product is per-purpose and per-match (`Match.vibeLat*` is a
 * departure pin for ONE date), and the one thing this feature must never
 * become is a table of where two people were, minute by minute, on the
 * evening they met. The window is forty-five minutes; an in-memory map is
 * therefore not a shortcut but the honest lifetime — a restart loses it and
 * the next ping restores it within seconds, which is the same trade
 * `services/usage-limiter.ts` and `services/promo-attribution.ts` already
 * make for state that is meaningless an hour later.
 *
 * Consequence to hold onto: this is single-process state, like those two. It
 * is correct while the bot runs as one PM2 process (ARCHITECTURE → Process
 * Layout) and would need rethinking the day that stops being true.
 *
 * ── The ETA is arithmetic, not a provider ───────────────────────────────
 *
 * `estimateEta` is a straight line times a detour factor over a city speed.
 * That is ±5–7 minutes, which is the accuracy a single rendered line
 * ("arriving 18:55") can actually carry, and it costs no key, no quota and
 * no outage. `RouteEstimator` is the one substitution point if a real
 * routing provider is ever wanted; nothing else in this module knows how the
 * number was produced.
 */

import {
  DATE_RADAR_LEAD_MINUTES,
  PROXIMITY_ARRIVED_RADIUS_M,
} from "@gennety/shared";

import { haversineDistanceKm, type LatLng } from "./geo.js";

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Pure half — testable without a clock, a database or a network
// ---------------------------------------------------------------------------

/** How the traveller is getting there. Whitelisted, never a free string. */
export type TravelMode = "walking" | "transit";

export function isTravelMode(value: unknown): value is TravelMode {
  return value === "walking" || value === "transit";
}

/**
 * Straight-line-to-real-route inflation, and the speed to divide it by.
 *
 * Both numbers are city figures rather than physical ones: 4.8 km/h is a
 * walking pace with crossings in it, and 18 km/h is public transport with the
 * wait and the walk at each end folded in — which is why the transit detour
 * factor is the LARGER of the two despite transit being the faster mode.
 */
const TRAVEL: Record<TravelMode, { detour: number; speedKmh: number }> = {
  walking: { detour: 1.35, speedKmh: 4.8 },
  transit: { detour: 1.6, speedKmh: 18 },
};

/**
 * Below this, transit is slower than walking once the wait is counted, so a
 * caller that does not name a mode is assumed to be on foot.
 */
const WALKABLE_KM = 2;

export function defaultModeFor(distanceKm: number): TravelMode {
  return distanceKm <= WALKABLE_KM ? "walking" : "transit";
}

export interface RouteEstimate {
  minutes: number;
  mode: TravelMode;
}

/** The seam a real routing provider would replace. */
export type RouteEstimator = (
  from: LatLng,
  to: LatLng,
  mode?: TravelMode,
) => RouteEstimate;

/**
 * Minutes from `from` to `to`, rounded up to the whole minute.
 *
 * Rounded UP on purpose: a person told 18:55 who arrives at 18:56 has been
 * lied to, while one told 18:56 who arrives at 18:55 has not. On the surface
 * this feeds — a single line the partner reads once — the asymmetry is the
 * whole of the accuracy argument.
 */
export const estimateEta: RouteEstimator = (from, to, mode) => {
  const km = haversineDistanceKm(from, to);
  const resolved = mode ?? defaultModeFor(km);
  const { detour, speedKmh } = TRAVEL[resolved];
  const minutes = Math.ceil(((km * detour) / speedKmh) * 60);
  return { minutes, mode: resolved };
};

/** Whether a ping is close enough to count as "here". */
export function hasArrived(at: LatLng, venue: LatLng): boolean {
  return haversineDistanceKm(at, venue) * 1000 <= PROXIMITY_ARRIVED_RADIUS_M;
}

export type RadarWindow = "ok" | "too-early" | "too-late";

/**
 * The radar runs from T−45m to `agreedTime` itself and not a minute past it.
 *
 * The upper bound is where this differs from the Bump, and the difference is
 * the point: a Bump is still meaningful an hour into a date that started late,
 * while "your match is on the way" stops being information the moment the date
 * has begun — from then on the two of them can see each other.
 */
export function checkRadarWindow(agreedTime: Date, at: Date): RadarWindow {
  const opens = agreedTime.getTime() - DATE_RADAR_LEAD_MINUTES * MINUTE_MS;
  if (at.getTime() < opens) return "too-early";
  if (at.getTime() > agreedTime.getTime()) return "too-late";
  return "ok";
}

/**
 * What one side is told about the other. This is the ENTIRE vocabulary the
 * partner-facing half of this feature has, and it is a closed set on purpose:
 * anything richer is a position report wearing a different word.
 */
export type PeerStatus = "unknown" | "en_route" | "arrived";

export interface RadarView {
  /** The PARTNER's state, never the caller's own. */
  peer: PeerStatus;
  /** Wall-clock arrival in the pair's city, `HH:mm`. Absent unless en route. */
  peerEtaLocal?: string;
  /** Both inside `PROXIMITY_ARRIVED_RADIUS_M` — the one celebratory beat. */
  bothArrived: boolean;
}

/** `HH:mm` in the pair's own city, because the date happens there. */
export function formatEtaLocal(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(at);
}

// ---------------------------------------------------------------------------
// Presence — in memory, bounded by the window itself
// ---------------------------------------------------------------------------

interface Presence {
  /** When they expect to be there. Absent once they are. */
  etaAt?: Date;
  arrived: boolean;
  /** Bounds the entry's life independently of any sweep. */
  seenAt: Date;
}

/** Key is `${matchId}:${side}` — the pair, not the person. */
const presence = new Map<string, Presence>();

/**
 * How long a ping speaks for the person who sent it.
 *
 * A phone that has gone quiet for this long is a phone we know nothing about,
 * and the honest answer then is `unknown` rather than a stale ETA — the failure
 * this bounds is telling someone their match is eight minutes away when that
 * was true a quarter of an hour ago.
 */
const PRESENCE_TTL_MS = 6 * MINUTE_MS;

const key = (matchId: string, side: "A" | "B"): string => `${matchId}:${side}`;

function readFresh(matchId: string, side: "A" | "B", now: Date): Presence | null {
  const k = key(matchId, side);
  const entry = presence.get(k);
  if (!entry) return null;
  if (now.getTime() - entry.seenAt.getTime() > PRESENCE_TTL_MS) {
    presence.delete(k);
    return null;
  }
  return entry;
}

export function recordPresence(
  matchId: string,
  side: "A" | "B",
  value: { etaAt?: Date; arrived: boolean },
  now: Date,
): void {
  // An arrival supersedes whatever ETA came with it rather than sitting beside
  // it — a person who is here has no arrival time, and carrying a stale one
  // would let a later read describe them as still moving.
  const etaAt = value.arrived ? undefined : value.etaAt;
  presence.set(key(matchId, side), {
    ...(etaAt ? { etaAt } : {}),
    arrived: value.arrived,
    seenAt: now,
  });
}

/**
 * What this side may be told about the other.
 *
 * The masking lives here rather than at the route, so there is exactly one
 * place that decides what crosses between two people — and it cannot leak a
 * coordinate because it never receives one.
 */
export function viewOfPeer(
  matchId: string,
  self: "A" | "B",
  now: Date,
  timeZone: string,
): RadarView {
  const peerSide = self === "A" ? "B" : "A";
  const peer = readFresh(matchId, peerSide, now);
  const mine = readFresh(matchId, self, now);
  const bothArrived = Boolean(peer?.arrived && mine?.arrived);

  if (!peer) return { peer: "unknown", bothArrived: false };
  if (peer.arrived) return { peer: "arrived", bothArrived };
  return {
    peer: "en_route",
    ...(peer.etaAt ? { peerEtaLocal: formatEtaLocal(peer.etaAt, timeZone) } : {}),
    bothArrived: false,
  };
}

/** Test seam — the map is process-wide and would otherwise leak between cases. */
export function resetRadarPresenceForTests(): void {
  presence.clear();
}
