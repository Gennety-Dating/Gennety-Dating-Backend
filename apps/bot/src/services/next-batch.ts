/**
 * Compute the next weekly match batch date from the MATCH_CRON_SCHEDULE.
 *
 * Default schedule: "0 18 * * 4" → every Thursday at 18:00 Europe/Kyiv.
 * This is a pure function (accepts `now` for testability) that never
 * hallucinates dates — it deterministically calculates the next occurrence
 * anchored to Europe/Kyiv wall-clock time (DST-aware via Intl API).
 */

/** Default cron: Thursday at 18:00 Kyiv. */
const DEFAULT_CRON = "0 18 * * 4";

/** Timezone for batch scheduling — matches node-cron `timezone` option. */
const BATCH_TZ = process.env.CRON_TIMEZONE ?? "Europe/Kyiv";

interface ParsedWeeklyCron {
  minute: number;
  hour: number;
  dayOfWeek: number; // 0 = Sunday, 6 = Saturday
}

/**
 * Parse a simple weekly cron expression (minute hour * * dayOfWeek).
 * Only supports the subset used by our match scheduler.
 */
export function parseWeeklyCron(expression: string): ParsedWeeklyCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`Invalid cron expression: "${expression}"`);
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  const dayOfWeek = Number(parts[4]);

  if (
    Number.isNaN(minute) || minute < 0 || minute > 59 ||
    Number.isNaN(hour) || hour < 0 || hour > 23 ||
    Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 7
  ) {
    throw new Error(`Cannot parse weekly cron: "${expression}"`);
  }

  // cron allows 7 for Sunday — normalise to 0
  return { minute, hour, dayOfWeek: dayOfWeek === 7 ? 0 : dayOfWeek };
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
 * Get the next occurrence of the weekly batch cron, relative to `now`,
 * anchored in Europe/Kyiv wall time. If `now` is exactly on the cron time,
 * returns the *next* week.
 */
export function getNextBatchDate(
  now: Date = new Date(),
  cronExpression?: string,
): Date {
  const cron = parseWeeklyCron(cronExpression ?? process.env.MATCH_CRON_SCHEDULE ?? DEFAULT_CRON);

  const kyivNow = getZonedParts(now, BATCH_TZ);
  let daysUntil = (cron.dayOfWeek - kyivNow.dayOfWeek + 7) % 7;

  let candidate = zonedWallToUtc(
    kyivNow.year,
    kyivNow.month,
    kyivNow.day + daysUntil,
    cron.hour,
    cron.minute,
    BATCH_TZ,
  );

  if (daysUntil === 0 && candidate.getTime() <= now.getTime()) {
    candidate = zonedWallToUtc(
      kyivNow.year,
      kyivNow.month,
      kyivNow.day + 7,
      cron.hour,
      cron.minute,
      BATCH_TZ,
    );
  }

  return candidate;
}

/**
 * Get the previous occurrence of the weekly batch cron, relative to `now`,
 * anchored in Europe/Kyiv wall time.
 */
export function getPreviousBatchDate(
  now: Date = new Date(),
  cronExpression?: string,
): Date {
  const next = getNextBatchDate(now, cronExpression);
  return getNextBatchDate(
    new Date(next.getTime() - 8 * 24 * 60 * 60 * 1000),
    cronExpression,
  );
}

/**
 * Human-readable string for the next batch date, formatted in Europe/Kyiv.
 * Example: "Thursday, April 16 at 18:00"
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
    timeZone: BATCH_TZ,
  });

  const timePart = next.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: BATCH_TZ,
  });

  return `${datePart} at ${timePart}`;
}
