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
 * Render the pinned banner for a user whose date is scheduled: a discrete
 * countdown to `dateAt` (same buckets as the next-match banner) with the venue
 * name appended when known. `status-timer.ts` uses this in place of the
 * next-batch countdown whenever the user has an upcoming scheduled date.
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

/**
 * Weekly matching batch runs on Thursday at 18:00 Europe/Kyiv (see
 * `MATCH_CRON_SCHEDULE` in apps/bot/src/index.ts). Compute the next
 * occurrence strictly AFTER `now` so a user viewing the banner at
 * 18:30 on Thursday sees "next match in 7 days", not "0 minutes".
 *
 * Europe/Kyiv is UTC+2 in winter / UTC+3 in summer. We use
 * `Intl.DateTimeFormat` to read the current Kyiv wall-clock and walk
 * forward in UTC until we land on Thursday 18:00 Kyiv.
 */
export function nextMatchDispatchAt(now: Date, timezone = "Europe/Kyiv"): Date {
  const kyiv = getZonedParts(now, timezone);

  // Days until next Thursday (weekday 4 in ISO; JS Date.getDay: Sun=0 … Sat=6).
  let daysUntilThu = (4 - kyiv.weekday + 7) % 7;

  // If it's already Thursday in Kyiv and at/past 18:00:00, skip to next week.
  if (
    daysUntilThu === 0 &&
    (kyiv.hour > 18 ||
      (kyiv.hour === 18 && (kyiv.minute > 0 || kyiv.second > 0)))
  ) {
    daysUntilThu = 7;
  }

  // Construct target wall-clock: Thursday at 18:00:00 Kyiv.
  const targetYear = kyiv.year;
  const targetMonth = kyiv.month; // 1–12
  const targetDay = kyiv.day + daysUntilThu;

  // Use Date.UTC + offset correction: find UTC instant whose Kyiv wall-clock
  // is (targetYear, targetMonth, targetDay, 18:00:00).
  return zonedWallClockToUtc(targetYear, targetMonth, targetDay, 18, 0, 0, timezone);
}

/**
 * True if `now` falls within the match-engine's typical processing
 * window — i.e. up to `windowMinutes` after the most recent Thursday
 * 18:00 Kyiv. During this window the timer should display "Analyzing
 * campus…" instead of jumping straight to "6d 23h".
 */
export function isMatchBatchProcessing(
  now: Date,
  windowMinutes = 10,
  timezone = "Europe/Kyiv",
): boolean {
  // Most recent Thursday 18:00 Kyiv is `nextMatchDispatchAt` of
  // (now - 7 days) — any instant strictly inside a given match week
  // has exactly one "previous" dispatch anchor.
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const previousDispatch = nextMatchDispatchAt(weekAgo, timezone);
  const diffMs = now.getTime() - previousDispatch.getTime();
  return diffMs >= 0 && diffMs <= windowMinutes * 60_000;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun … 6=Sat
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl returns "24" at midnight in some locales — normalise.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayMap[map.weekday] ?? 0,
  };
}

/**
 * Convert a wall-clock time in `timezone` to the corresponding UTC `Date`.
 * Uses a single offset-correction iteration which is exact for all IANA
 * zones that observe DST transitions only on hour boundaries (Europe/Kyiv
 * qualifies).
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = getZonedParts(new Date(utcGuess), timezone);
  const zoned = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMs = zoned - utcGuess;
  return new Date(utcGuess - offsetMs);
}
