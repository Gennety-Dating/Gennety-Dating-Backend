import { prisma } from "@gennety/db";
import { activityDay, markUserActive } from "../services/activity.js";

/**
 * Daily reconcile of `user_activity_days` from `chat_events`.
 *
 * This is what makes the metric trustworthy rather than merely cheap. The live
 * mark in `services/activity.ts` is fire-and-forget and swallows its errors —
 * correct, because it sits on the path of every inbound update and must never
 * cost a user their action — which means a mark CAN be lost: a database blip,
 * a process killed mid-write, a deploy landing between the two statements.
 *
 * `chat_events` is an independent record of the same fact, written by the same
 * inbound paths, so re-deriving from it recovers whatever the live path
 * dropped. Idempotent by construction: every write is the same upsert keyed on
 * `(day, user, platform)`, so a re-run cannot double-count a person — only
 * `events` moves, and that column is not what DAU/MAU reads.
 *
 * **It cannot be the only mechanism, which is why the live mark exists.**
 * `workers/retention.ts` deletes `chat_events` after 30 days, so a reconcile is
 * a repair for the recent past and never a source of history. The live mark is
 * what puts the row there in the first place; this only fills the gaps.
 */

/**
 * How far back a tick re-derives.
 *
 * Two days, not one: the sweep runs shortly after UTC midnight, so "yesterday"
 * is the day that just closed and "today" is the handful of hours already
 * banked. A single-day window would leave the last minutes before midnight to
 * be repaired only if someone noticed. Deliberately far short of the 30-day
 * `chat_events` retention — re-deriving the whole window nightly would be a
 * full-table scan for rows that were already reconciled the night they closed.
 */
export const RECONCILE_LOOKBACK_DAYS = 2;

export interface ActivityRollupResult {
  /** Distinct `(day, user)` pairs found in the timeline for the window. */
  scanned: number;
  /** Pairs that had no row and were repaired. */
  repaired: number;
  /** Pairs whose repair itself failed — non-zero means look at the logs. */
  failed: number;
}

/**
 * Re-derive activity rows for the last `RECONCILE_LOOKBACK_DAYS` days.
 *
 * Reads the inbound timeline, groups it into `(day, user)` pairs, and marks
 * only those that are missing. Marking every pair unconditionally would be
 * correct too, but it would rewrite every row nightly for no gain — the point
 * is to find holes, not to redo work.
 */
export async function activityRollupTick(
  now: Date = new Date(),
): Promise<ActivityRollupResult> {
  const from = new Date(
    activityDay(now).getTime() - (RECONCILE_LOOKBACK_DAYS - 1) * 86_400_000,
  );

  const events = await prisma.chatEvent.findMany({
    // `direction: "in"` is the same predicate the live mark uses — the two must
    // agree on what activity IS, or the reconcile would invent days the live
    // path deliberately did not count (a bot-sent nudge is not engagement).
    where: { direction: "in", createdAt: { gte: from } },
    select: { userId: true, createdAt: true },
  });

  // Earliest instant per (day, user), so a repaired row carries a real
  // `firstSeenAt` rather than the moment the sweep happened to run.
  const earliest = new Map<string, { userId: string; day: Date; at: Date }>();
  for (const e of events) {
    const day = activityDay(e.createdAt);
    const key = `${day.getTime()}|${e.userId}`;
    const seen = earliest.get(key);
    if (!seen || e.createdAt < seen.at) {
      earliest.set(key, { userId: e.userId, day, at: e.createdAt });
    }
  }

  if (earliest.size === 0) return { scanned: 0, repaired: 0, failed: 0 };

  const existing = await prisma.userActivityDay.findMany({
    where: {
      platform: "telegram",
      activityDate: { gte: from },
      userId: { in: [...new Set([...earliest.values()].map((v) => v.userId))] },
    },
    select: { activityDate: true, userId: true },
  });
  const have = new Set(
    existing.map((r) => `${activityDay(r.activityDate).getTime()}|${r.userId}`),
  );

  let repaired = 0;
  let failed = 0;
  for (const [key, pair] of earliest) {
    if (have.has(key)) continue;
    try {
      // `force` bypasses the same-day dedup cache: this is replaying history,
      // and a cache entry the live path happened to set must not silence a
      // repair for a row that is demonstrably absent from the table.
      await markUserActive(pair.userId, "telegram", { at: pair.at, force: true });
      repaired++;
    } catch (err) {
      failed++;
      console.warn("[activity-rollup] repair failed:", err);
    }
  }

  return { scanned: earliest.size, repaired, failed };
}
