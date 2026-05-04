import { t, type Language } from "@gennety/shared";

/**
 * Helpers for the "⏳ Xh left to reply" plate appended to match-proposal
 * pitches. Shared between the dispatch path (initial render at T-24h) and
 * the proposal-countdown worker (hourly / 5-minute live edits).
 *
 * Granularity rule (ceil for hours so `T+0` shows "24h" not "23h"):
 *   - `≥ 60` minutes left → hours, ceiled ("23h left"). Combined with a
 *     5-min worker tick this naturally gives one edit per hour during the
 *     first 23 hours: ceil only changes at exact hour boundaries.
 *   - `< 60` minutes left → raw minute count. With the same 5-min tick
 *     this gives one edit per 5 minutes during the final hour, matching
 *     the product cadence (hourly first 23h, every 5min last hour).
 *   - `≤ 0`               → final "expired" notice (rendered, but the
 *     expiry job overwrites the message body before this branch is hit).
 *
 * Both callers (dispatch & worker) must render byte-identical strings so
 * the worker's no-op cache can skip unchanged Telegram edits — keep the
 * format here, not duplicated at call sites.
 */

export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Compute minutes remaining (may be negative if past TTL). */
export function minutesLeftFromDispatch(
  dispatchedAt: Date,
  now: Date = new Date(),
  ttlMs: number = PROPOSAL_TTL_MS,
): number {
  const elapsedMs = now.getTime() - dispatchedAt.getTime();
  const remainingMs = ttlMs - elapsedMs;
  return Math.floor(remainingMs / 60_000);
}

/** Render the plate text for a given language and minutes-left value. */
export function renderCountdownPlate(
  lang: Language,
  minutesLeft: number,
): string {
  if (minutesLeft <= 0) return t(lang, "pitchExpired");
  if (minutesLeft >= 60) {
    const hours = Math.ceil(minutesLeft / 60);
    return t(lang, "pitchCountdownHours", { hours });
  }
  return t(lang, "pitchCountdownMinutes", { minutes: minutesLeft });
}

/**
 * Append the plate to a pitch text, separated by a blank line. Used at
 * dispatch and re-used by the worker when rebuilding the message body for
 * `editMessageText`.
 */
export function appendCountdownPlate(
  pitchBody: string,
  lang: Language,
  minutesLeft: number,
): string {
  return `${pitchBody}\n\n${renderCountdownPlate(lang, minutesLeft)}`;
}
