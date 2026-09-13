/**
 * How often the canvas asks the server what state it is in.
 *
 * Pure, so the cadence is a decision with a stated reason rather than a number
 * buried in a `setInterval` — and testable, which a timer is not.
 *
 * ── Why it is not one interval ──────────────────────────────────────────
 *
 * The canvas is a screen someone leaves open, so a flat fast poll is a battery
 * and radio cost paid mostly by users in `IDLE_EXPLORING`, where the thing
 * being waited for is a drop that happens once an evening. The states differ
 * by orders of magnitude in how soon their answer can change:
 *
 *   - `DATE_RADAR_ACTIVE` — the partner is moving; a stale reading here is the
 *     whole failure the radar exists to avoid.
 *   - `DATE_BUMP_PENDING` — the partner's shake can land at any second, and
 *     the pair is looking at the screen while it does.
 *   - everything else — nothing changes without the user or a cron acting, and
 *     a minute of lag is invisible.
 */

import type { CanvasState } from "./sheet.js";

export const POLL_FAST_MS = 5_000;
export const POLL_IDLE_MS = 60_000;

/**
 * Backoff after a failed call, so a server that is down is not hammered by
 * every open canvas at once. Caps rather than growing forever: the screen has
 * to recover on its own when the network comes back, and a user who has been
 * offline for an hour must not then wait an hour more.
 */
export const POLL_ERROR_BASE_MS = 5_000;
export const POLL_ERROR_MAX_MS = 60_000;

export function pollIntervalFor(state: CanvasState): number {
  return state === "DATE_RADAR_ACTIVE" || state === "DATE_BUMP_PENDING"
    ? POLL_FAST_MS
    : POLL_IDLE_MS;
}

/** Doubling backoff, capped. `failures` is the count of consecutive failures. */
export function backoffFor(failures: number): number {
  if (failures <= 0) return POLL_ERROR_BASE_MS;
  return Math.min(POLL_ERROR_BASE_MS * 2 ** (failures - 1), POLL_ERROR_MAX_MS);
}

/**
 * What a failed call means for the words on screen (A13-M31).
 *
 * The canvas and the terminal used to go quiet on every failure once they had
 * drawn something, so a lost connection left "arriving 18:55" on screen as if
 * it were live. Two failures deserve a sentence, and they are different ones:
 *
 *   - `reopen` — 401. The Mini App's initData has expired (it lives two hours),
 *     and no amount of retrying fixes that; only opening it again from the
 *     chat does.
 *   - `offline` — no answer at all, 429, or a 5xx: the server is unreachable
 *     or asking for room, and the poll's own backoff will get through.
 *
 * Every other refusal (outside the radar window, a stale match) is a state of
 * the date, not of the connection, and stays silent as before.
 *
 * `status` is the HTTP status, or null when no response arrived.
 */
export type ConnectionTrouble = "reopen" | "offline";

export function connectionTroubleFor(status: number | null): ConnectionTrouble | null {
  if (status === 401) return "reopen";
  if (status === null || status === 429 || status >= 500) return "offline";
  return null;
}

/**
 * Consecutive failed radar pings after which the last reading stops speaking
 * for the partner. Living Canvas spec: "a phone that goes quiet becomes
 * `unknown`, not a stale ETA". At the radar's 5 s cadence this is ~15 s — long
 * enough to ride out one dropped request, short enough that an ETA is never
 * shown well after the line went dead.
 */
export const RADAR_STALE_AFTER_FAILURES = 3;

export function radarReadingStale(consecutiveFailures: number): boolean {
  return consecutiveFailures >= RADAR_STALE_AFTER_FAILURES;
}
