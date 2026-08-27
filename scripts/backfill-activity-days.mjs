#!/usr/bin/env node
/**
 * Backfill `user_activity_days` from the existing chat timeline.
 *
 * DAU/MAU starts empty on deploy. `chat_events` already holds every inbound
 * action, so the recent past can be reconstructed rather than waited for —
 * which matters because without it the first MAU reading is a 30-day window
 * containing one day of data, i.e. a number that looks like a collapse.
 *
 * **The horizon is not a choice.** `workers/retention.ts` deletes the timeline
 * after 30 days, so that is exactly how far back the history exists. Anything
 * older is genuinely unrecoverable, and this script does not pretend otherwise.
 *
 * Dry run by default; `--apply` writes. Idempotent — the upsert is keyed on
 * (day, user, platform), so re-running cannot double-count anyone.
 *
 *   pnpm activity:backfill              # what it would write
 *   pnpm activity:backfill:apply        # write it
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

/** Must match `activityDay()` in services/activity.ts — UTC calendar day. */
function activityDay(at) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

async function main() {
  const events = await prisma.chatEvent.findMany({
    where: { direction: "in" },
    select: { userId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (events.length === 0) {
    console.log("No inbound chat events — nothing to backfill.");
    return;
  }

  // (day, user) -> { first, last, events }
  const pairs = new Map();
  for (const e of events) {
    const day = activityDay(e.createdAt);
    const key = `${day.getTime()}|${e.userId}`;
    const cur = pairs.get(key);
    if (!cur) {
      pairs.set(key, { userId: e.userId, day, first: e.createdAt, last: e.createdAt, events: 1 });
      continue;
    }
    if (e.createdAt < cur.first) cur.first = e.createdAt;
    if (e.createdAt > cur.last) cur.last = e.createdAt;
    cur.events++;
  }

  const days = new Set([...pairs.values()].map((p) => p.day.toISOString().slice(0, 10)));
  const users = new Set([...pairs.values()].map((p) => p.userId));
  const sorted = [...days].sort();

  console.log(
    `Scanned ${events.length} inbound events → ${pairs.size} (day, user) rows` +
      `\n  days:  ${sorted.length} (${sorted[0]} … ${sorted[sorted.length - 1]})` +
      `\n  users: ${users.size}`,
  );

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (const p of pairs.values()) {
    await prisma.$executeRaw`
      INSERT INTO user_activity_days
        (activity_date, user_id, platform, first_seen_at, last_seen_at, events)
      VALUES
        (${p.day}::date, ${p.userId}::uuid, 'telegram', ${p.first}, ${p.last}, ${p.events})
      ON CONFLICT (activity_date, user_id, platform) DO UPDATE SET
        first_seen_at = LEAST(user_activity_days.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(user_activity_days.last_seen_at, EXCLUDED.last_seen_at),
        -- The backfill KNOWS the true count for the day, so it replaces rather
        -- than increments: incrementing would add a re-run's worth every time.
        events        = GREATEST(user_activity_days.events, EXCLUDED.events)
    `;
    written++;
  }

  console.log(`\nWrote ${written} rows.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
