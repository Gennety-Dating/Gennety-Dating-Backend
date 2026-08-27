import { prisma } from "@gennety/db";

/**
 * DAU/MAU substrate — the write side (see `UserActivityDay` in the Prisma
 * schema for why the table exists and why it is a daily rollup).
 *
 * One job: when a person DOES something, make sure there is a row saying they
 * were active that day. Everything else about the metric — who counts, which
 * window, which timezone the reader wants — is a read-side decision and lives
 * in `admin/utils/activity.ts`.
 *
 * Two properties this module is built around:
 *
 *   1. **It is on the path of every inbound update.** So it must be cheap and
 *      it must never be able to fail a handler. Marks are fire-and-forget and
 *      swallow their own errors, exactly like `services/chat-events.ts`.
 *   2. **A lost mark is recoverable.** Because (1) means marks CAN be lost,
 *      `workers/activity-rollup.ts` re-derives the same rows from
 *      `chat_events` on a daily tick. That reconcile is what turns a
 *      best-effort write into a reliable metric, and it is the reason this
 *      file is allowed to be fire-and-forget in the first place.
 */

/**
 * Surfaces a day of activity can belong to.
 *
 * Deliberately NOT the Prisma `Platform` enum. That one describes an ACCOUNT
 * and has a `both` value; this describes one day on one surface, where `both`
 * is meaningless — someone active on two surfaces is two rows, which is what
 * makes a per-platform DAU breakdown possible.
 */
export type ActivityPlatform = "telegram" | "ios";

export const ACTIVITY_PLATFORMS: readonly ActivityPlatform[] = [
  "telegram",
  "ios",
];

export function isActivityPlatform(value: string): value is ActivityPlatform {
  return (ACTIVITY_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The UTC calendar day an instant belongs to, as a midnight-UTC `Date`.
 *
 * Pure, and exported for the read side and the tests: every place that has to
 * agree on what "a day" is calls this, so the bucket can never be computed two
 * slightly different ways. `@db.Date` stores only the date part, but Prisma
 * round-trips it as a `Date`, so midnight UTC is the canonical form.
 */
export function activityDay(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

/** `YYYY-MM-DD` for a UTC day. The wire format for every activity endpoint. */
export function activityDayKey(at: Date): string {
  return activityDay(at).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Same-day dedup
// ---------------------------------------------------------------------------

/**
 * Who has already been marked today, so a chatty user costs one write a day
 * rather than one per message.
 *
 * In-memory and single-process — the same assumption `services/usage-limiter.ts`
 * and the chat-target cache already make. Losing it costs nothing: the marks it
 * suppresses are upserts that would have written the same row, so a restart
 * means a few redundant upserts, never a wrong number.
 *
 * It is NOT a correctness mechanism. Correctness is the composite primary key.
 */
const markedToday = new Map<string, number>();

/** Bound the map so a long-running process cannot grow it without limit. */
const MARK_CACHE_MAX_ENTRIES = 20_000;

/** Test seam — drop everything cached. */
export function clearActivityCache(): void {
  markedToday.clear();
}

function cacheKey(userId: string, platform: ActivityPlatform, day: Date): string {
  return `${day.getTime()}|${platform}|${userId}`;
}

/**
 * Drop entries from days that are over.
 *
 * Cheap because it only ever runs when the map is already at its ceiling, and
 * it keeps the common case — one long-lived process across many days — from
 * holding every user it has ever seen.
 */
function evictStale(currentDay: Date): void {
  const cutoff = currentDay.getTime();
  for (const [key] of markedToday) {
    const dayPart = Number(key.slice(0, key.indexOf("|")));
    if (dayPart < cutoff) markedToday.delete(key);
  }
  // Still full — every entry is from today. Drop the lot rather than grow: the
  // cost is redundant upserts, and the alternative is unbounded memory.
  if (markedToday.size >= MARK_CACHE_MAX_ENTRIES) markedToday.clear();
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

export interface MarkActiveOptions {
  /** When the activity happened. Defaults to now. Always interpreted as UTC. */
  at?: Date;
  /**
   * Skip the same-day dedup cache and always write.
   *
   * Used by the reconcile worker, which is replaying history and must not be
   * silenced by a cache entry the live path happened to set.
   */
  force?: boolean;
}

/**
 * Record that `userId` was active on `platform`.
 *
 * Fire-and-forget by design — callers sit in the path of an update being
 * handled. Returns a promise only so the worker and the tests can await it;
 * ordinary call sites should not.
 */
export async function markUserActive(
  userId: string,
  platform: ActivityPlatform,
  options: MarkActiveOptions = {},
): Promise<void> {
  const at = options.at ?? new Date();
  const day = activityDay(at);
  const key = cacheKey(userId, platform, day);

  if (!options.force && markedToday.has(key)) return;

  try {
    // Raw upsert rather than `prisma.userActivityDay.upsert` for one reason:
    // the conflict branch has to fold the new instant into the row rather than
    // overwrite it — `first_seen_at` may only move BACKWARD and `last_seen_at`
    // only FORWARD. Prisma's update payload has no `GREATEST`/`LEAST`, so the
    // typed version would either clobber the earliest time or let the daily
    // reconcile (which replays older events) rewind a live mark. Doing it in
    // one statement also makes it atomic: no read-modify-write to race.
    await prisma.$executeRaw`
      INSERT INTO user_activity_days
        (activity_date, user_id, platform, first_seen_at, last_seen_at, events)
      VALUES
        (${day}::date, ${userId}::uuid, ${platform}, ${at}, ${at}, 1)
      ON CONFLICT (activity_date, user_id, platform) DO UPDATE SET
        events        = user_activity_days.events + 1,
        first_seen_at = LEAST(user_activity_days.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(user_activity_days.last_seen_at, EXCLUDED.last_seen_at)
    `;
    markedToday.set(key, day.getTime());
    if (markedToday.size >= MARK_CACHE_MAX_ENTRIES) evictStale(day);
  } catch (err) {
    // Deliberately swallowed: this must never cost a user their action. The
    // daily reconcile re-derives whatever is lost here from `chat_events`.
    console.warn("[activity] mark failed:", err);
  }
}
