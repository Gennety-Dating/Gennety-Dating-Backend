/**
 * Dev-only: pre-fill `availableTimesA/B` on a seeded `negotiating` calendar
 * match so the Mini App lands directly on the interesting peer-aware states
 * without a human having to tap on both accounts.
 *
 * Produces, from the standard 6-date × 5-slot `proposedTimes` grid:
 *   - day 0 → A picks 18:00, B picks 19:00  → SAME day, DIFFERENT time
 *             (the «Другое время» / "Other time" `mixed` state — the one
 *             whose long label now lifts into the top window).
 *   - day 1 → only B picks 18:00            → peer-only «Собеседник» card.
 *
 * No exact overlap is created, so nothing auto-locks and the match stays in
 * the picker for inspection.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/seed-calendar-picks.ts <matchId>
 *
 * NOT for production — refuses to run unless DATABASE_URL points at localhost.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
const repoRoot = resolve(import.meta.dirname, "../../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

// SAFETY: this writes match availability directly — only ever the dev DB.
const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1):/.test(dbUrl)) {
  console.error(
    `Refusing to run: DATABASE_URL does not target localhost (got host ` +
      `${dbUrl.replace(/.*@([^/]+)\/.*/, "$1") || "?"}). This is a dev-only helper.`,
  );
  process.exit(2);
}

const { prisma } = await import("@gennety/db");

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

async function main(): Promise<void> {
  const matchId = process.argv[2];
  if (!matchId) {
    console.error("Usage: tsx scripts/dev/seed-calendar-picks.ts <matchId>");
    process.exit(1);
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, status: true, proposedTimes: true },
  });
  if (!match) {
    console.error(`No match ${matchId}.`);
    process.exit(3);
  }
  if (match.proposedTimes.length === 0) {
    console.error("Match has no proposedTimes — run seed-calendar-match.ts first.");
    process.exit(4);
  }

  // Group the flat allowlist into days, each sorted by time.
  const byDay = new Map<string, Date[]>();
  for (const t of match.proposedTimes) {
    const d = new Date(t);
    const k = dayKey(d);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(d);
  }
  const days = Array.from(byDay.values())
    .map((slots) => slots.sort((a, b) => a.getTime() - b.getTime()))
    .sort((a, b) => a[0]!.getTime() - b[0]!.getTime());

  if (days.length < 2 || days[0]!.length < 4) {
    console.error("Unexpected grid shape — need ≥2 days and ≥4 slots/day.");
    process.exit(5);
  }

  const day0 = days[0]!; // [17:30, 18:00, 18:30, 19:00, 19:30]
  const day1 = days[1]!;
  const aPicks = [day0[1]!]; //           A: day0 18:00
  const bPicks = [day0[3]!, day1[1]!]; // B: day0 19:00 (mixed), day1 18:00 (peer-only)

  await prisma.match.update({
    where: { id: matchId },
    data: {
      availableTimesA: aPicks,
      availableTimesB: bPicks,
      agreedTime: null,
    },
  });

  const fmt = (d: Date): string =>
    d.toLocaleString("ru-RU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  console.log(`Pre-picked availability on match ${matchId}:`);
  console.log(`  A: ${aPicks.map(fmt).join(", ")}`);
  console.log(`  B: ${bPicks.map(fmt).join(", ")}`);
  console.log(
    `\nBoth sides now see day 0 as «Другое время» (same day, different time).`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    void prisma.$disconnect();
    process.exit(1);
  });
