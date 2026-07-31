import type { Language } from "../types.js";
import { t } from "../i18n.js";

/**
 * Live discrete timer for the pinned "next match" banner.
 *
 * Cron ticks every minute (see `status-timer.ts`). The rendered string
 * therefore changes every minute during the hours/minutes phase and every
 * hour during the days phase — the banner feels alive without bumping
 * against Telegram's per-chat edit throttles.
 */
export type StatusTimerPhase =
  | "days"        // > 24h — renders "Xd Yh"
  | "hours"       // 1h–24h — renders "Xh Ym"
  | "minutes"     // < 1h — renders "Xm"
  | "processing";

export interface StatusTimerInput {
  now: Date;
  nextMatchAt: Date;
  /** True while the weekly match-engine batch is actively running. */
  isProcessing?: boolean;
}

export interface StatusTimerSnapshot {
  phase: StatusTimerPhase;
  days?: number;
  hours?: number;
  minutes?: number;
}

/**
 * Bucket a time-to-match into the snapshot used for rendering. Pure —
 * easy to unit-test without i18n or string assembly.
 */
export function computeStatusSnapshot(input: StatusTimerInput): StatusTimerSnapshot {
  if (input.isProcessing) return { phase: "processing" };

  const diffMs = input.nextMatchAt.getTime() - input.now.getTime();

  // Match moment passed but we haven't been told we're processing —
  // treat as processing so users see something sensible instead of "0m".
  if (diffMs <= 0) return { phase: "processing" };

  // Round UP so a banner seen at 17:59:30 shows "1m" (not "0m") and a
  // banner at 2h 00m 30s shows "2h 1m" — the user's mental model is
  // "time remaining, rounded up to the next whole unit".
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hoursOfDay = totalHours % 24;
  const minutesOfHour = totalMinutes % 60;

  if (days >= 1) {
    return { phase: "days", days, hours: hoursOfDay };
  }
  if (totalHours >= 1) {
    return { phase: "hours", hours: totalHours, minutes: minutesOfHour };
  }
  return { phase: "minutes", minutes: Math.max(1, totalMinutes) };
}

/**
 * Render the snapshot into the user-facing banner string for the given
 * language. Layout and units come from the i18n table; this function
 * only picks the right key and supplies placeholder values.
 */
export function formatStatusText(
  input: StatusTimerInput,
  lang: Language,
): string {
  const snap = computeStatusSnapshot(input);

  switch (snap.phase) {
    case "processing":
      return t(lang, "statusProcessing");
    case "days":
      return t(lang, "statusDaysHours", {
        d: snap.days ?? 0,
        h: snap.hours ?? 0,
      });
    case "hours":
      return t(lang, "statusHoursMinutes", {
        h: snap.hours ?? 0,
        m: snap.minutes ?? 0,
      });
    case "minutes":
      return t(lang, "statusMinutes", { m: snap.minutes ?? 0 });
  }
}

export interface DateCountdownInput {
  now: Date;
  /** The user's locked-in `agreedTime`. */
  dateAt: Date;
  /** Venue name appended after the countdown when known (a proper noun — no
   *  translation needed; only the surrounding phrase is localized). */
  venueName?: string | null;
}

/**
 * Render the additional pinned-banner line for a scheduled date: a discrete
 * countdown to `dateAt` with the venue name appended when known. The next-drop
 * status remains primary and this line supplements it.
 */
export function formatDateCountdownText(
  input: DateCountdownInput,
  lang: Language,
): string {
  const snap = computeStatusSnapshot({ now: input.now, nextMatchAt: input.dateAt });
  let base: string;
  switch (snap.phase) {
    case "days":
      base = t(lang, "statusDateDaysHours", { d: snap.days ?? 0, h: snap.hours ?? 0 });
      break;
    case "hours":
      base = t(lang, "statusDateHoursMinutes", { h: snap.hours ?? 0, m: snap.minutes ?? 0 });
      break;
    case "minutes":
      base = t(lang, "statusDateMinutes", { m: snap.minutes ?? 0 });
      break;
    default:
      // `processing` = the agreed time is now/just passed — the date is today.
      base = t(lang, "statusDateSoon");
  }
  const venue = input.venueName?.trim();
  return venue ? `${base} · ${venue}` : base;
}
