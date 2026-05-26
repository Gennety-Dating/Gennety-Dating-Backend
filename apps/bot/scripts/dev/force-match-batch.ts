/**
 * One-shot: force the weekly matching batch outside its Thursday 18:00 Kyiv
 * cron. Runs `runWeeklyBatch()` and then `dispatchMatches()` against the dev
 * bot's API. Safe to run while `pnpm dev:bot` is up — Telegram long-polling
 * is owned by the dev bot process; we only issue Bot API HTTP calls here.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/force-match-batch.ts
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set — a coarse guard
 * against accidentally firing this against the production bot.
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

if (!process.env.DEV_OTP_BYPASS_TELEGRAM_IDS) {
  console.error(
    "[force-match-batch] refusing to run: DEV_OTP_BYPASS_TELEGRAM_IDS is empty.\n" +
      "  This script is for local dev only. Set the bypass list in .env.local first.",
  );
  process.exit(1);
}

if (!process.env.BOT_TOKEN) {
  console.error("[force-match-batch] BOT_TOKEN missing");
  process.exit(1);
}

const { prisma } = await import("@gennety/db");
const { Bot } = await import("grammy");
const { runWeeklyBatch } = await import("../../src/services/match-engine.js");
const { dispatchMatches } = await import("../../src/services/dispatch-queue.js");

const bot = new Bot(process.env.BOT_TOKEN);
await bot.init(); // populates bot.botInfo so api calls have username context

console.log("[force-match-batch] running weekly batch...");
const result = await runWeeklyBatch();
console.log(
  `[force-match-batch] batch result: eligible=${result.eligible} pairs=${result.pairs} missed=${result.missedUserIds.length}`,
);

if (result.matchIds.length === 0) {
  console.log("[force-match-batch] no matches to dispatch — done");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`[force-match-batch] dispatching ${result.matchIds.length} pitches...`);
const dispatch = await dispatchMatches(bot.api, result.matchIds, 500);
console.log(
  `[force-match-batch] dispatch complete: sent=${dispatch.dispatched} failed=${dispatch.failed}`,
);
if (dispatch.errors.length > 0) {
  console.log("[force-match-batch] errors:");
  for (const e of dispatch.errors) {
    console.log(`  match=${e.matchId}: ${e.error}`);
  }
}

await prisma.$disconnect();
