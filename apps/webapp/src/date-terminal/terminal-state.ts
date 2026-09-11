/**
 * The Date Terminal's decisions — pure, so they are tested without a browser,
 * a GPS fix or a phone to shake (the same split `canvas/sheet.ts` makes).
 *
 * The terminal is ONE ticket for one date, reading the same `/v1/date/state`
 * the canvas reads. What it adds on top is the lock the product asks for:
 * Contact Sync stays shut until the server's window is open AND this phone is
 * within `GEOFENCE_RADIUS_M` of the venue. The server re-checks both on every
 * shake (`POST /v1/dates/:id/bump`); the client lock exists so a couple is
 * never invited to shake at a moment the server would refuse.
 */

import type { CanvasState } from "../canvas/sheet.js";

/**
 * How close to the venue a shake must be, in metres. MIRRORS
 * `BUMP_VENUE_RADIUS_M` (`packages/shared/src/date-lifecycle.ts`) —
 * `apps/webapp` deliberately does not depend on `@gennety/shared`. A drift
 * here can never grant a sync (the server checks its own constant), but a lock
 * that disagrees with the server is a real couple told "too far" at a real
 * table, so the two must move together.
 */
export const GEOFENCE_RADIUS_M = 100;

/** MIRRORS `DATE_BUMP_OPENS_MINUTES` — when the server starts accepting a shake. */
export const SYNC_OPENS_MINUTES = 15;

/** A position older than this is re-read before a shake is posted. */
export const FIX_MAX_AGE_MS = 20_000;

/** Distances are shown rounded UP to this step, so GPS jitter does not flicker. */
export const DISTANCE_STEP_M = 5;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres (haversine — the server's formula). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const radius = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The server's own rule, on raw coordinates: `≤ radius` is in. */
export function withinGeofence(distanceM: number | null): boolean {
  return distanceM !== null && distanceM <= GEOFENCE_RADIUS_M;
}

export type MotionStatus = "idle" | "armed" | "denied" | "unsupported";

export type TerminalPhase =
  /** Not this date (a stale button), or the date is over. */
  | "closed"
  /** A legacy row whose venue point is the route midpoint — nothing to sync against. */
  | "no-venue-point"
  /** The date is on, the sync window is not open yet. */
  | "early"
  /** Window open; this phone is not within the geofence (or has no fix yet). */
  | "approach"
  /** Window open and within the geofence; motion not armed yet. */
  | "ready"
  /** Listening for the shake. */
  | "armed"
  /** Server-confirmed mutual sync. */
  | "synced";

export interface TerminalInput {
  /** The match this terminal was opened for (`?match=`). */
  matchId: string;
  state: CanvasState;
  /** The match `/v1/date/state` describes, or null when there is none. */
  stateMatchId: string | null;
  venue: LatLng | null;
  bumpVerified: boolean;
  distanceM: number | null;
  motion: MotionStatus;
}

const OPEN_STATES: ReadonlySet<CanvasState> = new Set<CanvasState>([
  "DATE_SCHEDULED",
  "DATE_RADAR_ACTIVE",
  "DATE_BUMP_PENDING",
  "DATE_IN_PROGRESS",
]);

export function terminalPhase(input: TerminalInput): TerminalPhase {
  // The state is about the caller's CURRENT date. A button from an older date
  // opens a terminal for a match the server is no longer talking about.
  if (input.stateMatchId !== input.matchId || !OPEN_STATES.has(input.state)) return "closed";
  // Verified wins over everything below it, including a lost GPS fix: the sync
  // already happened, and the deck is what the pair came back for.
  if (input.bumpVerified || input.state === "DATE_IN_PROGRESS") return "synced";
  if (input.venue === null) return "no-venue-point";
  if (input.state !== "DATE_BUMP_PENDING") return "early";
  if (!withinGeofence(input.distanceM)) return "approach";
  return input.motion === "armed" ? "armed" : "ready";
}

/** The lock the product asks for: Contact Sync is usable only in these two. */
export function syncUnlocked(phase: TerminalPhase): boolean {
  return phase === "ready" || phase === "armed";
}

/** Whether the terminal should be watching the phone's position at all. */
export function wantsLocation(phase: TerminalPhase): boolean {
  return phase === "early" || phase === "approach" || phase === "ready" || phase === "armed";
}

/** When the sync window opens, from the date's agreed time. */
export function syncOpensAt(agreedTime: Date): Date {
  return new Date(agreedTime.getTime() - SYNC_OPENS_MINUTES * 60_000);
}

/**
 * "105 m" / "1,4 km". Metres round UP to `DISTANCE_STEP_M`, the same
 * direction the radar rounds its ETA: "you're 100 m away" when you are 103 is
 * a lie the lock would then contradict, "105 m" is not.
 */
export function formatDistance(
  meters: number,
  lang: string,
  s: { metres: string; kilometres: string },
): string {
  if (meters < 1000) {
    const shown = Math.max(DISTANCE_STEP_M, Math.ceil(meters / DISTANCE_STEP_M) * DISTANCE_STEP_M);
    return s.metres.replace("{n}", String(shown));
  }
  const km = new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(
    Math.ceil(meters / 100) / 10,
  );
  return s.kilometres.replace("{n}", km);
}

/** A wall-clock time in 24h, the way every other surface in the product prints one. */
export function formatClock(at: Date, lang: string): string {
  return new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}
