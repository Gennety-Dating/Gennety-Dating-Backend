/**
 * Compute the next/previous match batch date from `MATCH_CRON_SCHEDULE`.
 *
 * Supports two cron shapes in the day-of-week field:
 *   - a single weekday or comma-list (`4` or `1,3,5`) — "next batch is the
 *     next occurrence of one of these weekdays";
 *   - `*` (every day) — "next batch is the next occurrence of this
 *     hour:minute, today or tomorrow".
 *
 * Both are pure functions (accept `now` for testability) that never
 * hallucinate dates — they deterministically calculate the occurrence
 * anchored to Europe/Kyiv wall-clock time (DST-aware via Intl API).
 *
 * `MATCH_CRON_SCHEDULE`'s default tracks the active `CADENCE` profile (see
 * `@gennety/shared`), so switching `DROP_CADENCE` also switches which cron
 * this file (and the `index.ts` registration that imports it) resolves to.
 * `MATCH_CRON_SCHEDULE` itself remains available as a manual override on top
 * of that default, matching every other `*_CRON_SCHEDULE` in this codebase.
 */

import { CADENCE } from "@gennety/shared";

/** Canonical schedule shared by node-cron, Telegram and /v1/countdown. */
export const MATCH_CRON_SCHEDULE =
  process.env.MATCH_CRON_SCHEDULE ?? CADENCE.cron;

/** Timezone for batch scheduling — matches node-cron `timezone` option. */
export const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? "Europe/Kyiv";

interface ParsedDropCron {
  minute: number;
  hour: number;
  /** `null` means "every day" (the cron's day-of-week field was `*`). */
  daysOfWeek: number[] | null; // 0 = Sunday, 6 = Saturday
}

/**
 * Parse a cron expression of the shape `minute hour * * dow`, where `dow` is
 * either `*` (every day), a single weekday (`0`-`7`, `7` normalised to `0`),
 * or a comma-separated list of weekdays (`1,3,5`). Day-of-month and month
 * fields are always `*` in this codebase and are not interpreted.
 */
export function parseDropCron(expression: string): ParsedDropCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`Invalid cron expression: "${expression}"`);
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  const dowField = parts[4]!;

  if (
    Number.isNaN(minute) || minute < 0 || minute > 59 ||
    Number.isNaN(hour) || hour < 0 || hour > 23
  ) {
    throw new Error(`Cannot parse drop cron: "${expression}"`);
  }

  if (dowField === "*") {
    return { minute, hour, daysOfWeek: null };
  }

  const rawDays = dowField.split(",").map((token) => Number(token.trim()));
  if (rawDays.some((d) => Number.isNaN(d) || d < 0 || d > 7)) {
    throw new Error(`Cannot parse drop cron: "${expression}"`);
  }
  // cron allows 7 for Sunday — normalise to 0, then dedupe.
  const daysOfWeek = [...new Set(rawDays.map((d) => (d === 7 ? 0 : d)))];
  return { minute, hour, daysOfWeek };
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number; // 0 = Sunday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // Intl may emit "24" for midnight in some envs
    minute: Number(map.minute),
    dayOfWeek: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/**
 * Convert a wall-clock time in `timeZone` to an absolute UTC Date.
 * DST-aware: the offset is recomputed for the target instant.
 */
function zonedWallToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // Start with naive UTC, then subtract the TZ offset at that instant.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const probeParts = getZonedParts(new Date(utcGuess), timeZone);
  const probeAsUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
  );
  const offset = probeAsUtc - utcGuess; // positive → zone is ahead of UTC
  return new Date(utcGuess - offset);
}

/**
 * Get the next occurrence of the drop cron, relative to `now`, anchored in
 * Europe/Kyiv wall time. If `now` is exactly on the cron time, returns the
 * *next* occurrence (today never re-fires on its own instant).
 */
export function getNextBatchDate(
  now: Date = new Date(),
  cronExpression?: string,
): Date {
  const cron = parseDropCron(cronExpression ?? MATCH_CRON_SCHEDULE);
  const kyivNow = getZonedParts(now, CRON_TIMEZONE);

  if (cron.daysOfWeek === null) {
    // Every day at hour:minute — try today first, else tomorrow.
    let candidate = zonedWallToUtc(
      kyivNow.year,
      kyivNow.month,
      kyivNow.day,
      cron.hour,
      cron.minute,
      CRON_TIMEZONE,
    );
    if (candidate.getTime() <= now.getTime()) {
      candidate = zonedWallToUtc(
        kyivNow.year,
        kyivNow.month,
        kyivNow.day + 1,
        cron.hour,
        cron.minute,
        CRON_TIMEZONE,
      );
    }
    return candidate;
  }

  // One or more explicit weekdays — find the earliest qualifying occurrence
  // strictly after `now` across all of them.
  let best: Date | null = null;
  for (const dow of cron.daysOfWeek) {
    const daysUntil = (dow - kyivNow.dayOfWeek + 7) % 7;
    let candidate = zonedWallToUtc(
      kyivNow.year,
      kyivNow.month,
      kyivNow.day + daysUntil,
      cron.hour,
      cron.minute,
      CRON_TIMEZONE,
    );
    if (candidate.getTime() <= now.getTime()) {
      candidate = zonedWallToUtc(
        kyivNow.year,
        kyivNow.month,
        kyivNow.day + daysUntil + 7,
        cron.hour,
        cron.minute,
        CRON_TIMEZONE,
      );
    }
    if (!best || candidate.getTime() < best.getTime()) best = candidate;
  }
  return best!;
}

/**
 * Get the previous occurrence of the drop cron, relative to `now`, anchored
 * in Europe/Kyiv wall time. Self-contained (mirrors `getNextBatchDate`'s own
 * search rather than subtracting a fixed interval), so it stays correct for
 * every cadence — daily, weekly, or an arbitrary explicit weekday list —
 * without depending on `CADENCE.intervalMs` matching whatever `cronExpression`
 * override a caller passed in.
 */
export function getPreviousBatchDate(
  now: Date = new Date(),
  cronExpression?: string,
): Date {
  const cron = parseDropCron(cronExpression ?? MATCH_CRON_SCHEDULE);
  const kyivNow = getZonedParts(now, CRON_TIMEZONE);

  if (cron.daysOfWeek === null) {
    let candidate = zonedWallToUtc(
      kyivNow.year,
      kyivNow.month,
      kyivNow.day,
      cron.hour,
      cron.minute,
      CRON_TIMEZONE,
    );
    if (candidate.getTime() > now.getTime()) {
      candidate = zonedWallToUtc(
        kyivNow.year,
        kyivNow.month,
        kyivNow.day - 1,
        cron.hour,
        cron.minute,
        CRON_TIMEZONE,
      );
    }
    return candidate;
  }

  let best: Date | null = null;
  for (const dow of cron.daysOfWeek) {
    const daysSince = (kyivNow.dayOfWeek - dow + 7) % 7;
    let candidate = zonedWallToUtc(
      kyivNow.year,
      kyivNow.month,
      kyivNow.day - daysSince,
      cron.hour,
      cron.minute,
      CRON_TIMEZONE,
    );
    if (candidate.getTime() > now.getTime()) {
      candidate = zonedWallToUtc(
        kyivNow.year,
        kyivNow.month,
        kyivNow.day - daysSince - 7,
        cron.hour,
        cron.minute,
        CRON_TIMEZONE,
      );
    }
    if (!best || candidate.getTime() > best.getTime()) best = candidate;
  }
  return best!;
}

/**
 * True while the most recently configured batch is expected to be
 * processing. Follows the exact same `MATCH_CRON_SCHEDULE` + `CRON_TIMEZONE`
 * inputs as node-cron and `/v1/countdown`.
 */
export function isBatchProcessing(
  now: Date = new Date(),
  windowMinutes = 10,
  cronExpression?: string,
): boolean {
  const previous = getPreviousBatchDate(now, cronExpression);
  const elapsedMs = now.getTime() - previous.getTime();
  return elapsedMs >= 0 && elapsedMs <= windowMinutes * 60_000;
}

/**
 * Human-readable string for the next batch date, formatted in Europe/Kyiv.
 * Weekly-shaped cron (explicit weekday list): "Thursday, April 16 at 18:00".
 * Daily-shaped cron (`*` weekday): "today/tomorrow at 18:00" is a Phase 6
 * copy concern (this function keeps rendering the full date, which reads
 * correctly either way — "Friday, April 17 at 18:00" is true regardless of
 * whether the batch runs every day or only on Fridays).
 */
export function formatNextBatchDate(
  now: Date = new Date(),
  cronExpression?: string,
  locale: string = "en-US",
): string {
  const next = getNextBatchDate(now, cronExpression);

  const datePart = next.toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: CRON_TIMEZONE,
  });

  const timePart = next.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: CRON_TIMEZONE,
  });

  return `${datePart} at ${timePart}`;
}
