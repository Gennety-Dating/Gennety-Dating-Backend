/**
 * Onboarding re-engagement schedule (Kyiv-local time).
 *
 * Chain of 5 progressively-spaced touches, anchored to the moment the user
 * went silent (`lastMessageAt`):
 *
 *   step 1: +15 min                  (hot reminder)
 *   step 2: +2 h
 *   step 3: drop-off day 19:00 Kyiv  (same-day evening)
 *   step 4: next day 19:00 Kyiv
 *   step 5: day+2 14:00 Kyiv         (afternoon free window)
 *   step 6+: null                    (chain exhausted)
 *
 * Hard quiet hours: 23:00–09:00 Kyiv. Any computed touch falling inside this
 * window is deferred to the next 13:00 Kyiv (start of the 13:00–19:00 free
 * window). A minimum gap from `lastMessageAt` is also enforced per step so
 * late-night drop-offs don't bunch several touches into the next morning.
 */

export const KYIV_TZ = "Europe/Kyiv";
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 9;
export const FREE_WINDOW_START_HOUR = 13;
export const EVENING_HOUR = 19;
export const AFTERNOON_HOUR = 14;

export const MAX_RE_ENGAGEMENT_STEP = 5;

const MIN_OFFSET_MS: Record<number, number> = {
  1: 15 * 60 * 1000,
  2: 2 * 60 * 60 * 1000,
  3: 6 * 60 * 60 * 1000,
  4: 22 * 60 * 60 * 1000,
  5: 40 * 60 * 60 * 1000,
};

/**
 * Compute the UTC moment of the next re-engagement touch for the given step,
 * or null when the chain is exhausted (step > MAX_RE_ENGAGEMENT_STEP).
 *
 * The result is guaranteed to be:
 *   - outside Kyiv quiet hours (23:00–09:00),
 *   - at least MIN_OFFSET_MS[step] after lastMessageAt,
 *   - strictly in the future relative to `now`.
 */
export function computeNextTouch(
  step: number,
  lastMessageAt: Date,
  now: Date,
): Date | null {
  if (step < 1 || step > MAX_RE_ENGAGEMENT_STEP) return null;

  const anchor = computeAnchor(step, lastMessageAt);
  const minAt = new Date(lastMessageAt.getTime() + MIN_OFFSET_MS[step]!);
  const futureFloor = new Date(now.getTime() + 60 * 1000);

  const candidate = new Date(
    Math.max(anchor.getTime(), minAt.getTime(), futureFloor.getTime()),
  );
  return shiftOutOfQuietHours(candidate);
}

function computeAnchor(step: number, lastMessageAt: Date): Date {
  switch (step) {
    case 1:
      return new Date(lastMessageAt.getTime() + 15 * 60 * 1000);
    case 2:
      return new Date(lastMessageAt.getTime() + 2 * 60 * 60 * 1000);
    case 3:
      return kyivWallClockToUtc(lastMessageAt, 0, EVENING_HOUR);
    case 4:
      return kyivWallClockToUtc(lastMessageAt, 1, EVENING_HOUR);
    case 5:
      return kyivWallClockToUtc(lastMessageAt, 2, AFTERNOON_HOUR);
    default:
      throw new Error(`invalid step ${step}`);
  }
}

export function isKyivQuietHour(date: Date): boolean {
  const h = kyivParts(date).hour;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * If `date` falls inside Kyiv quiet hours, return the nearest 13:00 Kyiv
 * moment in the future. Otherwise return `date` unchanged.
 */
export function shiftOutOfQuietHours(date: Date): Date {
  const k = kyivParts(date);
  const inQuiet = k.hour >= QUIET_START_HOUR || k.hour < QUIET_END_HOUR;
  if (!inQuiet) return date;

  // 23:00–23:59 → defer to tomorrow's 13:00; 00:00–08:59 → today's 13:00.
  const dayOffset = k.hour >= QUIET_START_HOUR ? 1 : 0;
  return buildKyivUtc(k.year, k.month, k.day + dayOffset, FREE_WINDOW_START_HOUR, 0);
}

interface KyivParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function kyivParts(date: Date): KyivParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: KYIV_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hourRaw = parts.hour ?? "0";
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: hourRaw === "24" ? 0 : Number(hourRaw),
    minute: Number(parts.minute),
  };
}

/**
 * Produce a UTC Date for `hour:00` Kyiv-local on the calendar day of
 * `base` (in Kyiv) plus `dayOffset` days.
 */
function kyivWallClockToUtc(base: Date, dayOffset: number, hour: number): Date {
  const { year, month, day } = kyivParts(base);
  return buildKyivUtc(year, month, day + dayOffset, hour, 0);
}

/** Convert a Kyiv-local wall-clock Y/M/D/H/M into the equivalent UTC Date. */
function buildKyivUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMin = kyivOffsetMinutes(new Date(utcGuess));
  return new Date(utcGuess - offsetMin * 60 * 1000);
}

/**
 * Prisma update patch for recording onboarding activity. Bumps
 * `lastMessageAt` and resets the re-engagement chain so the next touch fires
 * 15 min after the moment supplied.
 */
export function onboardingActivityPatch(now: Date = new Date()): {
  lastMessageAt: Date;
  reEngagementStep: number;
  reEngagementNextAt: Date | null;
} {
  return {
    lastMessageAt: now,
    reEngagementStep: 0,
    reEngagementNextAt: computeNextTouch(1, now, now),
  };
}

/** Prisma update patch for terminating the chain (onboarding finished). */
export const reEngagementStopPatch = {
  reEngagementStep: 0,
  reEngagementNextAt: null as Date | null,
};

function kyivOffsetMinutes(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: KYIV_TZ,
    timeZoneName: "shortOffset",
  });
  const tzName =
    fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!match) return 120; // Fallback: Kyiv standard time = UTC+2.
  const sign = match[1] === "-" ? -1 : 1;
  const h = Number(match[2]);
  const m = Number(match[3] ?? "0");
  return sign * (h * 60 + m);
}
