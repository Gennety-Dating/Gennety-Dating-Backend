import { t, type Language } from "@gennety/shared";
import { minutesLeftUntilDeadline } from "../services/proposal-deadline.js";

/**
 * Helpers for the reply-deadline countdown on match-proposal pitches.
 *
 * Two renderers live here. {@link renderCountdownButtonLabel} is the live one:
 * minute-granular, shared by the dispatch path (initial render at T-24h) and
 * the proposal-countdown worker, which re-renders it every minute.
 * {@link renderCountdownPlate} / {@link appendCountdownPlate} are the legacy
 * body-text plate (hourly granularity) kept for the mobile/legacy rendering
 * path and its tests.
 *
 * Legacy-plate granularity rule (ceil for hours so `T+0` shows "24h" not
 * "23h"):
 *   - `≥ 60` minutes left → hours, ceiled ("23h left") — the string only
 *     changes at exact hour boundaries, whatever the tick cadence.
 *   - `< 60` minutes left → raw minute count.
 *   - `≤ 0`               → final "expired" notice (rendered, but the
 *     expiry job overwrites the message body before this branch is hit).
 *
 * Both callers (dispatch & worker) must render byte-identical strings so
 * the worker's no-op cache can skip unchanged Telegram edits — keep the
 * format here, not duplicated at call sites.
 *
 * The deadline itself (was a locally-declared `PROPOSAL_TTL_MS` constant,
 * independently duplicating `match-expiry.ts`'s `MATCH_TTL_MS`) now lives in
 * `services/proposal-deadline.ts` — see that module's header for why the
 * weekly/daily formulas are genuinely different shapes, not just different
 * numbers.
 */

/** Compute minutes remaining until the reply deadline (may be negative once
 *  it has passed). */
export function minutesLeftFromDispatch(
  dispatchedAt: Date,
  now: Date = new Date(),
): number {
  return minutesLeftUntilDeadline(dispatchedAt, now);
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
 * Render the label for the live "reply deadline" inline button that rides the
 * pitch keyboard (2026-07-23). Unlike {@link renderCountdownPlate} (a body-text
 * plate with hourly, ceil-hours granularity), this shows hours+minutes so the
 * button visibly ticks every worker pass — the countdown reads as *alive*, the
 * way the pinned status-banner button does. The proposal-countdown worker
 * edits ONLY this button's markup, so the pitch body (synergy header + text)
 * is never rewritten.
 *
 * Caller guarantees `minutesLeft > 0` (past-TTL rows are left to the expiry
 * job, which clears the keyboard); we clamp defensively anyway.
 */
export function renderCountdownButtonLabel(
  lang: Language,
  minutesLeft: number,
): string {
  const safe = Math.max(minutesLeft, 0);
  if (safe >= 60) {
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    return t(lang, "pitchDeadlineBtnHm", { h, m });
  }
  return t(lang, "pitchDeadlineBtnMin", { m: safe });
}

/**
 * Append the plate to a pitch text, separated by a blank line. Retained for the
 * mobile/legacy body-text rendering and its tests; the Telegram pitch now
 * carries the countdown as an inline button (see
 * {@link renderCountdownButtonLabel}) instead of appending this plate.
 */
export function appendCountdownPlate(
  pitchBody: string,
  lang: Language,
  minutesLeft: number,
): string {
  return `${pitchBody}\n\n${renderCountdownPlate(lang, minutesLeft)}`;
}
