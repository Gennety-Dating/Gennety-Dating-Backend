/**
 * Pure scheduling + question-selection logic for the Profiler
 * (PRODUCT_SPEC §Phase 1b). No DB, no Telegram — everything here is a pure
 * function of `now`, the user's timezone, and their answer rows, so the
 * batch cadence and the skip/return state machine are fully unit-testable.
 *
 * Local-time math mirrors `workers/re-engagement-schedule.ts` and
 * `services/next-batch.ts`: DST-aware via `Intl.DateTimeFormat`, no tz library.
 */

import {
  DEFAULT_TIME_ZONE,
  PROFILER_BATCH_SIZE_NORMAL,
  PROFILER_BATCH_SIZE_RUSH,
  PROFILER_EVENING_HOUR,
  PROFILER_MORNING_HOUR,
  PROFILER_RUSH_WINDOW_HOURS,
  profilerQuestionBank,
  type ProfilerQuestion,
} from "@gennety/shared";
import type { Gender } from "@gennety/shared";

/** Kyiv-style quiet window, applied in the USER's local time. */
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 9;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

// zonedParts / wallToUtc are generic timezone primitives (no Profiler state);
// they're exported for reuse by the Calendar grid (`generateProposalSlots`),
// which also needs wall-clock-in-Kyiv → UTC conversion.
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
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

function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const tzName =
    new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

/** Convert a wall-clock Y/M/D/H:M in `timeZone` to the equivalent UTC instant. */
export function wallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = zoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset * 60 * 1000);
}

/** Resolve a stored zone, falling back to the default when null/blank. */
export function resolveZone(timeZone: string | null | undefined): string {
  return timeZone && timeZone.trim() ? timeZone : DEFAULT_TIME_ZONE;
}

/** Local wall-clock hour (0..23) in the given zone. */
export function localHour(date: Date, timeZone: string | null | undefined): number {
  return zonedParts(date, resolveZone(timeZone)).hour;
}

/** True when the local time falls in the [23:00, 09:00) quiet window. */
export function isQuietHourLocal(date: Date, timeZone: string | null | undefined): boolean {
  const h = localHour(date, timeZone);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * Rush mode: a drop is imminent (< PROFILER_RUSH_WINDOW_HOURS away), so the
 * Profiler shrinks batches but keeps using both daily windows to fill the
 * profile before the event.
 */
export function isRushMode(now: Date, nextDrop: Date): boolean {
  const hoursUntil = (nextDrop.getTime() - now.getTime()) / (60 * 60 * 1000);
  return hoursUntil > 0 && hoursUntil <= PROFILER_RUSH_WINDOW_HOURS;
}

/** Questions to send in one batch given the current mode. */
export function batchSizeFor(rush: boolean): number {
  return rush ? PROFILER_BATCH_SIZE_RUSH : PROFILER_BATCH_SIZE_NORMAL;
}

/**
 * The next morning (09:00) or evening (18:00) batch window strictly after
 * `after`, in the user's local time. Both modes rotate through both windows;
 * the natural 9h/15h spacing satisfies PROFILER_INTER_BATCH_GAP_HOURS.
 */
export function nextWindowAt(after: Date, timeZone: string | null | undefined): Date {
  const tz = resolveZone(timeZone);
  const base = zonedParts(after, tz);
  const hours = [PROFILER_MORNING_HOUR, PROFILER_EVENING_HOUR];

  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    for (const hour of hours) {
      const candidate = wallToUtc(
        base.year,
        base.month,
        base.day + dayOffset,
        hour,
        0,
        tz,
      );
      if (candidate.getTime() > after.getTime()) return candidate;
    }
  }
  // Unreachable in practice; keep the type total.
  return wallToUtc(base.year, base.month, base.day + 1, PROFILER_MORNING_HOUR, 0, tz);
}

/**
 * First-question time after onboarding: `entryAt` (now + entry delay) unless
 * that lands inside the user's local quiet hours, in which case defer to the
 * next 09:00 window so we never ping at 3am.
 */
export function firstQuestionAt(entryAt: Date, timeZone: string | null | undefined): Date {
  if (!isQuietHourLocal(entryAt, timeZone)) return entryAt;
  return nextWindowAt(entryAt, timeZone);
}

// ---------------------------------------------------------------------------
// Question selection + skip/return state machine
// ---------------------------------------------------------------------------

export interface ProfilerAnswerRow {
  questionId: string;
  answerText: string | null;
  skipped: boolean;
  skipReturned: boolean;
  cycleId: string;
}

/**
 * Pick the next question to ask, in priority (bank) order:
 *   1. The first never-asked question (no row at all).
 *   2. Otherwise the first skipped question eligible to "return once" — i.e.
 *      a skip that has NOT already been re-offered-and-re-skipped in the
 *      current cycle. A question skip-suppressed in a *previous* cycle
 *      becomes eligible again (spec §2.3/§2.4).
 * Answered questions are done forever. Returns null when nothing's pending.
 */
export function selectNextProfilerQuestion(
  gender: Gender | null,
  rows: ProfilerAnswerRow[],
  currentCycleId: string,
): ProfilerQuestion | null {
  const bank = profilerQuestionBank(gender);
  const byId = new Map(rows.map((r) => [r.questionId, r]));

  // Pass 1: never-asked questions.
  for (const q of bank) {
    if (!byId.has(q.id)) return q;
  }
  // Pass 2: skipped questions eligible to return.
  for (const q of bank) {
    const row = byId.get(q.id);
    if (!row) continue;
    if (row.answerText) continue; // answered → done
    if (!row.skipped) continue;
    const suppressedThisCycle = row.skipReturned && row.cycleId === currentCycleId;
    if (!suppressedThisCycle) return q;
  }
  return null;
}

/**
 * Compute the patch for a skip, implementing "comes back once, then drops
 * until the next cycle":
 *   - a fresh skip (no prior row, or a row from an earlier cycle) →
 *     skipped, NOT yet returned.
 *   - re-skipping a question already skipped earlier in THIS cycle →
 *     skipReturned = true (suppress until next cycle).
 */
export function skipTransition(
  existing: ProfilerAnswerRow | undefined,
  currentCycleId: string,
): { skipped: boolean; skipReturned: boolean } {
  const skippedThisCycleAlready =
    !!existing && existing.skipped && existing.cycleId === currentCycleId;
  return { skipped: true, skipReturned: skippedThisCycleAlready };
}
