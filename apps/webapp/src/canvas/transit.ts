/**
 * The transit dock's arithmetic and its visibility rule (decision 2026-09-11)
 * — pure, so both are tested without a map, a GPS fix or a browser: the split
 * `sheet.ts` makes for the sheet.
 *
 * ── The ETA is arithmetic, not a routing provider ──────────────────────
 *
 * The radar's answer to the same question (PRODUCT_SPEC §6.3): a straight line
 * times a city detour factor, over a city speed, rounded UP. That is ±5–7
 * minutes — the accuracy one rendered line can carry — and it costs no key, no
 * quota, no outage and no request, so the position it starts from never
 * leaves the phone. `travelMinutes` is the one substitution point if a real
 * router is ever wanted; nothing else knows how the number was produced.
 */

import { GEOFENCE_RADIUS_M } from "../date-terminal/terminal-state.js";
import type { TravelMode } from "../deep-links.js";
import type { CanvasStrings } from "./i18n.js";
import type { CanvasState } from "./sheet.js";

/**
 * Straight line → real route, and the speed to cover it at.
 *
 * Walking MIRRORS the radar's (`TRAVEL.walking` in apps/bot/src/services/
 * date-radar.ts): this card says "17 min on foot" a few pixels above a sheet
 * whose radar line says "arriving 18:55", and two formulas for one walk would
 * make one of them wrong.
 *
 * Driving has no server twin (the radar's other mode is transit). 1.4 is the
 * road detour of a European city — Kyiv's river crossings keep it at the top
 * of that range; 25 km/h is door to door in city traffic; the two fixed
 * minutes are pulling away and pulling in, which dominate a short hop and
 * vanish on a long one. That is how 2 km reads "9 min by car" rather than a
 * flattering 7.
 */
const TRAVEL: Record<TravelMode, { detour: number; speedKmh: number; fixedMinutes: number }> = {
  walking: { detour: 1.35, speedKmh: 4.8, fixedMinutes: 0 },
  driving: { detour: 1.4, speedKmh: 25, fixedMinutes: 2 },
};

/**
 * MIRRORS the radar's `WALKABLE_KM`: the same line between "you'd walk it" and
 * "you wouldn't", so the dock's first guess agrees with the radar's.
 */
export const WALKABLE_M = 2_000;

/**
 * Where the dock steps aside on its own: the Date Terminal's geofence, itself
 * the client's mirror of the server's `BUMP_VENUE_RADIUS_M`. Inside it the
 * next thing to do is shake, not hail a car, and the sheet's button says so.
 */
export const ARRIVED_M = GEOFENCE_RADIUS_M;

/** Past this a city speed says nothing: 300 km at 25 km/h is not a trip anyone takes. */
export const CITY_RANGE_M = 60_000;

export function travelMinutes(distanceM: number, mode: TravelMode): number {
  const { detour, speedKmh, fixedMinutes } = TRAVEL[mode];
  const minutes = ((Math.max(0, distanceM) / 1000) * detour * 60) / speedKmh + fixedMinutes;
  // Up, for the radar's reason: told 12 and there in 13 is a lie, told 13 and
  // there in 12 is not. The epsilon keeps float noise (27.000000000000004)
  // from adding a minute to a result that is exact.
  return Math.max(1, Math.ceil(minutes - 1e-9));
}

/** Minutes, or null once the distance is beyond anything a city speed describes. */
export function etaMinutes(distanceM: number, mode: TravelMode): number | null {
  return distanceM > CITY_RANGE_M ? null : travelMinutes(distanceM, mode);
}

export function defaultModeFor(distanceM: number): TravelMode {
  return distanceM <= WALKABLE_M ? "walking" : "driving";
}

/** "9 min", "1 h", "1 h 24 min" — minutes up to the hour, then hours and minutes. */
export function formatTravelTime(
  minutes: number,
  s: Pick<CanvasStrings, "dockMinutes" | "dockHours" | "dockHoursMinutes">,
): string {
  if (minutes < 60) return s.dockMinutes.replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? s.dockHours.replace("{h}", String(hours))
    : s.dockHoursMinutes.replace("{h}", String(hours)).replace("{m}", String(rest));
}

/**
 * Whether the dock exists in a state, and how it comes up:
 *
 *   - `auto` — DATE_RADAR_ACTIVE and DATE_BUMP_PENDING, from T-45m until the
 *     date has begun. The departure window, where "how do I get there" IS the
 *     question: the dock comes up on its own and a tap on the map does not put
 *     it away. It spans the bump window too, because running late is exactly
 *     when a car matters; it steps aside only on arrival (`ARRIVED_M`).
 *   - `on-demand` — DATE_SCHEDULED: time and place are fixed, the evening is
 *     hours or days off. A tap on the venue pin brings it up, a tap on the map
 *     puts it away.
 *   - `off` — nothing to go to yet, or the two of them are already together.
 *
 * Only with a venue POINT. The server nulls it for a legacy row whose column
 * holds the route midpoint (`venueCoordinatesOf`), and a car sent to a
 * crossroads a kilometre from the table is worse than no button.
 */
export type DockPresence = "off" | "on-demand" | "auto";

export function dockPresenceFor(state: CanvasState, hasVenuePoint: boolean): DockPresence {
  if (!hasVenuePoint) return "off";
  if (state === "DATE_RADAR_ACTIVE" || state === "DATE_BUMP_PENDING") return "auto";
  if (state === "DATE_SCHEDULED") return "on-demand";
  return "off";
}

/**
 * Whether the dock is on screen right now. A summon — the pin tapped — wins
 * whenever the dock exists, arrival included: someone at the venue asking for
 * directions is still asking.
 */
export function dockShown(input: {
  presence: DockPresence;
  summoned: boolean;
  distanceM: number | null;
}): boolean {
  if (input.presence === "off") return false;
  if (input.summoned) return true;
  if (input.presence === "on-demand") return false;
  return !(input.distanceM !== null && input.distanceM <= ARRIVED_M);
}
