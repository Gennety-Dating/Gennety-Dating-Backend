/**
 * Cohort retention — "of the people who registered in one bucket, how many
 * were still active N days later".
 *
 * Pure functions only; the loading lives in `activity-source.ts`. Same split
 * as `activity.ts` / `user-health.ts`, and for the same reason: the part that
 * is a PRODUCT decision (what a cohort is, what "retained" means, when a
 * number may be reported at all) has to be testable without a database.
 *
 * This is deliberately NOT the same metric as `/admin/analytics/retention`,
 * which reports a SURVIVAL curve: it asks whether a user's LAST activity is at
 * least N weeks after signup, so someone whose final action was on day 57 and
 * who has been gone ever since counts as retained at every offset up to 8
 * weeks. That reads higher than retention actually is, monotonically. What is
 * computed here is return-in-a-window, which is what the word normally means.
 *
 * Three rules run through the whole file, each of which the numbers are
 * useless without:
 *
 *   • **A missing measurement is `null`, never `0`.** "Nobody came back" and
 *     "we could not have seen them come back" are different claims, and only
 *     one of them is about users. Two distinct causes are reported separately
 *     (`immature`, `no-data`) because they call for different actions.
 *   • **Day 0 is the day of registration and is never counted.** Retention is
 *     about coming BACK; counting the signup session makes day-1 look like
 *     100% for anyone who finished onboarding in one sitting.
 *   • **The denominator is signups, not day-0 actives.** The founder's
 *     question is "of those who installed", so the cohort is everyone who
 *     registered in the bucket, including people who never did anything.
 */

import { DAY_MS, toDayKey } from "./activity.js";
import type { ActivityRow } from "./activity.js";

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export type CohortBucket = "day" | "week" | "month";
export const COHORT_BUCKETS: CohortBucket[] = ["day", "week", "month"];

export function isCohortBucket(v: string): v is CohortBucket {
  return (COHORT_BUCKETS as string[]).includes(v);
}

/** Midnight UTC of the same calendar day. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/**
 * First and last UTC day of the bucket containing `at`.
 *
 * Weeks are Monday-anchored, matching `monetization.ts`'s `weekStartOf` rather
 * than `buckets.ts`'s `isoWeekKey`: both describe the same week, but a start
 * DATE can have days added to it, which is what the maturity test below needs,
 * and `2026-W35` cannot.
 */
export function bucketRangeOf(at: Date, bucket: CohortBucket): { start: Date; end: Date } {
  const d = utcDay(at);
  if (bucket === "day") return { start: d, end: d };
  if (bucket === "week") {
    // getUTCDay(): 0 = Sunday. Shift so the week starts on Monday.
    const shift = (d.getUTCDay() + 6) % 7;
    const start = addDays(d, -shift);
    return { start, end: addDays(start, 6) };
  }
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  // Day 0 of the next month is the last day of this one — no month-length table.
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start, end };
}

/** Human label for a bucket: `2026-08-14`, the Monday `2026-08-10`, or `2026-08`. */
export function bucketLabel(start: Date, bucket: CohortBucket): string {
  const key = toDayKey(start);
  return bucket === "month" ? key.slice(0, 7) : key;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

/**
 * One column of the matrix: "was the user active in the `windowDays` days
 * ending on day `day`".
 *
 * The width exists because an exact-day reading is the wrong instrument for
 * THIS product. The whole rhythm here is weekly — one drop, one famine notice,
 * one check-in ladder — so a perfectly healthy user has no reason to open the
 * bot on any particular day, and `windowDays: 1` at day 30 would be measuring
 * the drop schedule rather than the person. It is the same argument
 * `activity.ts` makes for reporting WAU beside DAU.
 *
 * Day 1 keeps `windowDays: 1` because there the exact day IS the question:
 * "did they come back the very next day" is a real, sharp signal, and a week
 * is not available to widen into anyway.
 */
export interface RetentionMilestone {
  /** Day offset from registration that the window ENDS on. Must be ≥ 1. */
  day: number;
  /** Window width in days, ending on `day`. 1 = that exact day. */
  windowDays: number;
}

/**
 * D1 = the next day. D7 = anywhere in week 1. D14 and D30 = the trailing week
 * ending on that day, so they read as "still around a fortnight / a month in"
 * rather than as a coin flip about one date.
 */
export const DEFAULT_MILESTONES: readonly RetentionMilestone[] = [
  { day: 1, windowDays: 1 },
  { day: 7, windowDays: 7 },
  { day: 14, windowDays: 7 },
  { day: 30, windowDays: 7 },
];

/** Milestones are only meaningful when the window sits entirely after day 0. */
export function isValidMilestone(m: RetentionMilestone): boolean {
  return (
    Number.isInteger(m.day) &&
    Number.isInteger(m.windowDays) &&
    m.day >= 1 &&
    m.windowDays >= 1 &&
    m.windowDays <= m.day
  );
}

/** Inclusive day offsets covered by a milestone, e.g. {30,7} → 24…30. */
export function milestoneOffsets(m: RetentionMilestone): { from: number; to: number } {
  return { from: m.day - m.windowDays + 1, to: m.day };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CohortUserInput {
  id: string;
  createdAt: Date;
  referralSource: string | null;
}

/**
 * Why a cell carries no number.
 *
 * `immature` — the cohort is too young: not every member has had the window
 * elapse yet, so a percentage would be dividing by people who have not had
 * their chance. Fixes itself with time.
 *
 * `no-data` — the activity table does not reach back far enough to see that
 * window at all. It never fixes itself with time, and reporting it as 0% would
 * describe a gap in our instrumentation as a fact about users. This is not
 * hypothetical: `user_activity_days` only began collecting in August 2026, and
 * `chat_events` (the only thing a backfill can read) is swept after 30 days.
 */
export type CellStatus = "ok" | "immature" | "no-data";

export interface CohortCell {
  day: number;
  windowDays: number;
  status: CellStatus;
  /** Users active in the window. `null` unless `status === "ok"`. */
  retained: number | null;
  retainedPct: number | null;
  /** `100 - retainedPct`, since the question is usually asked as churn. */
  churnedPct: number | null;
}

export interface CohortRetentionRow {
  /** Display label: `2026-08-14`, a Monday, or `2026-08`. */
  cohort: string;
  cohortStart: string;
  cohortEnd: string;
  size: number;
  /** Too few people for a percentage to mean anything. Flagged, never hidden. */
  lowSample: boolean;
  cells: CohortCell[];
}

export interface CohortAverageCell extends CohortCell {
  /** How many cohorts and users the average is over — a weighted mean of one
   *  cohort is that cohort, and the reader has to be able to see that. */
  cohorts: number;
  users: number;
}

export interface CohortRetentionMatrix {
  bucket: CohortBucket;
  milestones: RetentionMilestone[];
  rows: CohortRetentionRow[];
  /** Size-weighted mean across the cohorts that are `ok` at each milestone. */
  average: CohortAverageCell[];
  totalUsers: number;
}

export interface ChannelRetentionRow {
  channel: string;
  signups: number;
  cells: CohortAverageCell[];
}

export interface CohortRetentionOptions {
  bucket?: CohortBucket;
  milestones?: readonly RetentionMilestone[];
  now?: Date;
  /**
   * Earliest UTC day the activity table can speak for. `null` = it holds
   * nothing at all, so every cell is `no-data`.
   */
  coverageFrom?: string | null;
  /** Cohorts smaller than this are flagged `lowSample`. */
  lowSampleBelow?: number;
}

/**
 * Twenty is not a statistical threshold, it is a legibility one: below it a
 * single person moves the percentage by five points or more, so the number
 * reads as noise and should be labelled as such rather than trusted.
 */
export const DEFAULT_LOW_SAMPLE_BELOW = 20;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/** `userId → set of UTC day keys they were active on`. */
export function activityIndex(rows: readonly ActivityRow[]): Map<string, Set<string>> {
  const byUser = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = byUser.get(r.userId);
    if (!set) byUser.set(r.userId, (set = new Set()));
    set.add(r.day);
  }
  return byUser;
}

function pct(num: number, den: number): number | null {
  return den > 0 ? +((num / den) * 100).toFixed(1) : null;
}

/**
 * Was this user active inside the milestone's window?
 *
 * Day keys are compared as strings, which is exact for `YYYY-MM-DD`: the
 * format is zero-padded and fixed-width, so lexical order IS chronological
 * order (the same reasoning `summarizeActivity` relies on).
 */
function activeInWindow(
  days: Set<string> | undefined,
  signupDay: Date,
  m: RetentionMilestone,
): boolean {
  if (!days || days.size === 0) return false;
  const { from, to } = milestoneOffsets(m);
  for (let n = from; n <= to; n++) {
    if (days.has(toDayKey(addDays(signupDay, n)))) return true;
  }
  return false;
}

/**
 * The last UTC day whose data is complete.
 *
 * Yesterday, not today: today is still filling, so a window that ends today
 * has not finished, and counting it would report every fresh cohort as worse
 * than it is. Same default, same reason, as the DAU endpoint's `defaultDay`.
 */
export function lastCompleteDay(now: Date): Date {
  return addDays(utcDay(now), -1);
}

function statusOf(
  m: RetentionMilestone,
  cohortEnd: Date,
  cohortStart: Date,
  complete: Date,
  coverageFrom: string | null | undefined,
): CellStatus {
  // Mature only when the NEWEST possible member of the cohort has had the
  // whole window elapse — the newest, not the oldest, or the last day's
  // signups are counted as churned for days they never had.
  if (toDayKey(addDays(cohortEnd, m.day)) > toDayKey(complete)) return "immature";
  if (coverageFrom == null) return "no-data";
  // The earliest window this cohort can produce belongs to its oldest member.
  // If instrumentation starts after that, part of the cohort's window was
  // never observed and the cell is unknown rather than zero.
  const earliestWindowStart = toDayKey(addDays(cohortStart, milestoneOffsets(m).from));
  return earliestWindowStart < coverageFrom ? "no-data" : "ok";
}

function emptyCell(m: RetentionMilestone, status: CellStatus): CohortCell {
  return {
    day: m.day,
    windowDays: m.windowDays,
    status,
    retained: null,
    retainedPct: null,
    churnedPct: null,
  };
}

export function computeCohortRetention(
  users: readonly CohortUserInput[],
  activity: readonly ActivityRow[],
  options: CohortRetentionOptions = {},
): CohortRetentionMatrix {
  const bucket = options.bucket ?? "week";
  const milestones = [...(options.milestones ?? DEFAULT_MILESTONES)].sort(
    (a, b) => a.day - b.day,
  );
  const now = options.now ?? new Date();
  const complete = lastCompleteDay(now);
  const coverageFrom = options.coverageFrom;
  const lowSampleBelow = options.lowSampleBelow ?? DEFAULT_LOW_SAMPLE_BELOW;

  const index = activityIndex(activity);

  const buckets = new Map<
    string,
    { start: Date; end: Date; users: CohortUserInput[] }
  >();
  for (const u of users) {
    const { start, end } = bucketRangeOf(u.createdAt, bucket);
    const key = toDayKey(start);
    let row = buckets.get(key);
    if (!row) buckets.set(key, (row = { start, end, users: [] }));
    row.users.push(u);
  }

  const rows: CohortRetentionRow[] = Array.from(buckets.values())
    .map(({ start, end, users: members }) => ({
      cohort: bucketLabel(start, bucket),
      cohortStart: toDayKey(start),
      cohortEnd: toDayKey(end),
      size: members.length,
      lowSample: members.length < lowSampleBelow,
      cells: milestones.map((m) => {
        const status = statusOf(m, end, start, complete, coverageFrom);
        if (status !== "ok") return emptyCell(m, status);
        let retained = 0;
        for (const u of members) {
          if (activeInWindow(index.get(u.id), utcDay(u.createdAt), m)) retained++;
        }
        const retainedPct = pct(retained, members.length);
        return {
          day: m.day,
          windowDays: m.windowDays,
          status,
          retained,
          retainedPct,
          churnedPct: retainedPct === null ? null : +(100 - retainedPct).toFixed(1),
        };
      }),
    }))
    .sort((a, b) => a.cohortStart.localeCompare(b.cohortStart));

  return {
    bucket,
    milestones,
    rows,
    average: averageCells(rows, milestones),
    totalUsers: users.length,
  };
}

/**
 * Size-weighted mean over the cohorts that actually produced a number.
 *
 * Weighted rather than a mean of percentages: a 4-person cohort and a
 * 400-person cohort are not two equal observations, and averaging their rates
 * lets the smallest week dominate the headline.
 */
export function averageCells(
  rows: readonly CohortRetentionRow[],
  milestones: readonly RetentionMilestone[],
): CohortAverageCell[] {
  return milestones.map((m, i) => {
    let retained = 0;
    let users = 0;
    let cohorts = 0;
    let sawImmature = false;
    for (const row of rows) {
      const cell = row.cells[i];
      if (!cell || cell.status !== "ok" || cell.retained === null) {
        if (cell?.status === "immature") sawImmature = true;
        continue;
      }
      retained += cell.retained;
      users += row.size;
      cohorts++;
    }
    if (cohorts === 0) {
      return {
        ...emptyCell(m, sawImmature ? "immature" : "no-data"),
        cohorts: 0,
        users: 0,
      };
    }
    const retainedPct = pct(retained, users);
    return {
      day: m.day,
      windowDays: m.windowDays,
      status: "ok" as const,
      retained,
      retainedPct,
      churnedPct: retainedPct === null ? null : +(100 - retainedPct).toFixed(1),
      cohorts,
      users,
    };
  });
}

/**
 * The same measurement sliced by acquisition channel — the row that belongs
 * next to CAC, because a channel that buys cheap signups who never come back
 * is more expensive than its CPL says.
 *
 * Cohorts are still computed per channel rather than averaged from the overall
 * matrix: maturity is a property of WHEN a channel's users arrived, and a
 * channel that only started last week has no mature cohorts even though the
 * overall matrix does.
 */
export function computeChannelRetention(
  users: readonly CohortUserInput[],
  activity: readonly ActivityRow[],
  normalizeChannel: (src: string | null) => string,
  options: CohortRetentionOptions = {},
): ChannelRetentionRow[] {
  const byChannel = new Map<string, CohortUserInput[]>();
  for (const u of users) {
    const channel = normalizeChannel(u.referralSource);
    let list = byChannel.get(channel);
    if (!list) byChannel.set(channel, (list = []));
    list.push(u);
  }

  return Array.from(byChannel.entries())
    .map(([channel, members]) => {
      const matrix = computeCohortRetention(members, activity, options);
      return { channel, signups: members.length, cells: matrix.average };
    })
    .sort((a, b) => b.signups - a.signups);
}
