/**
 * DAU/MAU — the read side. Pure functions only, so the definitions are
 * testable without a database (the split `user-health.ts` already makes).
 *
 * The write side is `services/activity.ts`; the storage rationale is on the
 * `UserActivityDay` model. What lives here is the part that is a PRODUCT
 * decision rather than a mechanism: which window a metric is measured over,
 * and what a number means once the window is chosen.
 */

/** One `(day, user)` pair, as the loader hands it over. */
export interface ActivityRow {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  userId: string;
  platform: string;
}

export const DAY_MS = 86_400_000;

/**
 * MAU is a ROLLING 30 days, not a calendar month.
 *
 * Both are offered by the endpoint, but this is the default and the one the
 * dashboard should read, for a reason specific to this product rather than
 * convention: the whole rhythm here is weekly — the drop, the famine notice,
 * the check-in ladder — so 30 days is exactly four of those cycles whatever
 * month it is. A calendar month contains four or five Thursdays, which would
 * make February structurally quieter than March by the calendar rather than by
 * the product, and a metric that moves for that reason cannot be read as a
 * trend.
 */
export const MAU_WINDOW_DAYS = 30;

/**
 * WAU is reported alongside, and at this cadence it is arguably the headline.
 *
 * A user with one drop a week has no reason to open the bot daily, so DAU
 * measures how many people happened to be mid-conversation today rather than
 * how many the product is holding. Under `weekly` cadence a healthy user can
 * be a 1-in-7 DAU participant and a 7-in-7 WAU one. Reporting DAU alone would
 * make a working product look nearly dead.
 */
export const WAU_WINDOW_DAYS = 7;

/** `YYYY-MM-DD` for a UTC day. */
export function toDayKey(at: Date): string {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/** Parse `YYYY-MM-DD` into midnight UTC. Returns null on anything else. */
export function parseDayKey(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const at = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return null;
  // Rejects the dates that parse but do not exist (2026-02-31 → March 3rd).
  return toDayKey(at) === raw ? at : null;
}

/** Parse `YYYY-MM` into the first and last UTC day of that calendar month. */
export function parseMonthKey(raw: string): { from: Date; to: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(raw)) return null;
  const [y, m] = raw.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return {
    from: new Date(Date.UTC(y, m - 1, 1)),
    // Day 0 of the next month is the last day of this one — no month-length table.
    to: new Date(Date.UTC(y, m, 0)),
  };
}

/** Inclusive list of `YYYY-MM-DD` keys from `from` to `to`. */
export function dayRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    out.push(toDayKey(new Date(t)));
  }
  return out;
}

/** The window `[from, to]` whose last day is `end`, spanning `days` days. */
export function windowEndingOn(end: Date, days: number): { from: Date; to: Date } {
  return { from: new Date(end.getTime() - (days - 1) * DAY_MS), to: end };
}

/**
 * Unique users in `rows` — the whole of what MAU/WAU are.
 *
 * Stated as its own function because it is the thing daily counters can never
 * give you: a person active on 12 days is one monthly active user, so summing
 * DAU over a month overcounts by however loyal the base is. Every window
 * number in this file goes through here.
 */
export function uniqueUsers(rows: readonly ActivityRow[]): number {
  const seen = new Set<string>();
  for (const r of rows) seen.add(r.userId);
  return seen.size;
}

/** Per-day unique user counts, zero-filled across the whole requested range. */
export function dailySeries(
  rows: readonly ActivityRow[],
  from: Date,
  to: Date,
): Array<{ date: string; dau: number }> {
  const byDay = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = byDay.get(r.day);
    if (!set) byDay.set(r.day, (set = new Set()));
    set.add(r.userId);
  }
  // Zero-filled rather than sparse: a day with no activity is a real data
  // point, and a chart that simply omits it draws a line through the gap.
  return dayRange(from, to).map((date) => ({
    date,
    dau: byDay.get(date)?.size ?? 0,
  }));
}

/** Unique users per platform, for the surface breakdown. */
export function byPlatform(rows: readonly ActivityRow[]): Record<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = sets.get(r.platform);
    if (!set) sets.set(r.platform, (set = new Set()));
    set.add(r.userId);
  }
  const out: Record<string, number> = {};
  for (const [platform, set] of sets) out[platform] = set.size;
  return out;
}

/**
 * DAU/MAU stickiness, as a percentage.
 *
 * `null` on an empty MAU rather than `0` — the two say different things ("no
 * users at all" vs "users, none of them daily"), and this file's own rule is
 * that a missing denominator is never reported as a measured zero.
 */
export function stickiness(dau: number, mau: number): number | null {
  return mau > 0 ? +((dau / mau) * 100).toFixed(1) : null;
}

export interface ActivitySummary {
  /** The day DAU is measured on, `YYYY-MM-DD` (UTC). */
  date: string;
  dau: number;
  wau: number;
  mau: number;
  /** DAU ÷ MAU as a percentage; null when MAU is 0. */
  stickinessPct: number | null;
  dauByPlatform: Record<string, number>;
  mauByPlatform: Record<string, number>;
  windows: { wauDays: number; mauDays: number };
}

/**
 * The headline block: DAU for `end`, plus the WAU/MAU windows ending on it.
 *
 * `rows` must already cover the widest window — the caller loads once and
 * slices here, rather than making three round trips for three overlapping
 * ranges of the same table.
 */
export function summarizeActivity(
  rows: readonly ActivityRow[],
  end: Date,
): ActivitySummary {
  const dayKey = toDayKey(end);
  const wau = windowEndingOn(end, WAU_WINDOW_DAYS);
  const mau = windowEndingOn(end, MAU_WINDOW_DAYS);

  const inWindow = (w: { from: Date; to: Date }): ActivityRow[] => {
    const fromKey = toDayKey(w.from);
    const toKey = toDayKey(w.to);
    // String comparison is safe and exact for `YYYY-MM-DD`: it is
    // zero-padded and fixed-width, so lexical order IS chronological order.
    return rows.filter((r) => r.day >= fromKey && r.day <= toKey);
  };

  const dayRows = rows.filter((r) => r.day === dayKey);
  const mauRows = inWindow(mau);
  const dauCount = uniqueUsers(dayRows);
  const mauCount = uniqueUsers(mauRows);

  return {
    date: dayKey,
    dau: dauCount,
    wau: uniqueUsers(inWindow(wau)),
    mau: mauCount,
    stickinessPct: stickiness(dauCount, mauCount),
    dauByPlatform: byPlatform(dayRows),
    mauByPlatform: byPlatform(mauRows),
    windows: { wauDays: WAU_WINDOW_DAYS, mauDays: MAU_WINDOW_DAYS },
  };
}
