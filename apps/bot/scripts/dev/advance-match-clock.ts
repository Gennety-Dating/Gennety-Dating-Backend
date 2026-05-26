/**
 * One-shot: shift a match's time-anchor columns by N hours so the
 * date-lifecycle interval (T-3h ice-breakers, T-1h safety/wingman,
 * T+24h feedback) and the proposal expiry cron (24h TTL) can be exercised
 * without waiting wall-clock time.
 *
 * Usage:
 *   # Shift agreedTime BACK by 3h (i.e. simulate "3h closer to date").
 *   # T-3h gate fires within ~2 min after running.
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
 *     <matchId> agreed -3h
 *
 *   # Push agreedTime fully into the past (simulate "date was 24h ago").
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
 *     <matchId> agreed -28h
 *
 *   # Backdate dispatchedAt to trigger 24h TTL expiry on the next /15-min cron.
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
 *     <matchId> dispatched -25h
 *
 * Columns supported: agreed | dispatched | nudge1 | nudge2
 * Offset format: e.g. "-3h", "+30m", "-25h". Sign required.
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set.
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

if (!process.env.DEV_OTP_BYPASS_TELEGRAM_IDS) {
  console.error("[advance-match-clock] refusing to run: DEV_OTP_BYPASS_TELEGRAM_IDS empty");
  process.exit(1);
}

const [, , matchId, columnArg, offsetArg] = process.argv;
if (!matchId || !columnArg || !offsetArg) {
  console.error(
    "usage: advance-match-clock.ts <matchId> <agreed|dispatched|nudge1|nudge2> <signed-offset like -3h or +30m>",
  );
  process.exit(1);
}

const offsetMatch = offsetArg.match(/^([+-])(\d+)([hm])$/);
if (!offsetMatch) {
  console.error(`[advance-match-clock] bad offset "${offsetArg}" — expected like -3h or +30m`);
  process.exit(1);
}
const sign = offsetMatch[1] === "+" ? 1 : -1;
const quantity = Number(offsetMatch[2]);
const unitMs = offsetMatch[3] === "h" ? 3600_000 : 60_000;
const deltaMs = sign * quantity * unitMs;

const columnMap: Record<string, string> = {
  agreed: "agreedTime",
  dispatched: "dispatchedAt",
  nudge1: "proposalNudge1SentAt",
  nudge2: "proposalNudge2SentAt",
};
const column = columnMap[columnArg];
if (!column) {
  console.error(`[advance-match-clock] unknown column "${columnArg}"`);
  process.exit(1);
}

const { prisma } = await import("@gennety/db");

const match = await prisma.match.findUnique({
  where: { id: matchId },
  select: {
    id: true,
    status: true,
    agreedTime: true,
    dispatchedAt: true,
    proposalNudge1SentAt: true,
    proposalNudge2SentAt: true,
  },
});
if (!match) {
  console.error(`[advance-match-clock] match ${matchId} not found`);
  process.exit(1);
}

const currentValue = (match as Record<string, Date | null>)[column];
if (!currentValue) {
  console.error(
    `[advance-match-clock] column ${column} is null on this match — set it via the normal flow first`,
  );
  process.exit(1);
}

const newValue = new Date(currentValue.getTime() + deltaMs);

console.log(`[advance-match-clock] match ${matchId} status=${match.status}`);
console.log(`  ${column}: ${currentValue.toISOString()} → ${newValue.toISOString()}`);

await prisma.match.update({
  where: { id: matchId },
  data: { [column]: newValue },
});

console.log("[advance-match-clock] updated");
await prisma.$disconnect();
