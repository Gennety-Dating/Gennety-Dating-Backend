/**
 * One-shot: force the drop matching batch outside its cron (Thursday 18:00
 * Kyiv under the `weekly` DropCadence profile; every day at 18:00 under
 * `daily` — see packages/shared/src/cadence.ts). Runs `runDropBatch()`,
 * notifies any proposals its own expiry preflight expired, then
 * `dispatchMatches()` the new pitches — mirroring `index.ts`'s
 * `dropMatchingJob`. Safe to run while `pnpm dev:bot` is up — Telegram
 * long-polling is owned by the dev bot process; we only issue Bot API HTTP
 * calls here.
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
const { runDropBatch } = await import("../../src/services/match-engine.js");
const { dispatchMatches } = await import("../../src/services/dispatch-queue.js");
const { sendExpiryNotifications } = await import("../../src/services/expiry-notify.js");

const bot = new Bot(process.env.BOT_TOKEN);
await bot.init(); // populates bot.botInfo so api calls have username context

console.log(`[force-match-batch] running drop batch (DROP_CADENCE=${process.env.DROP_CADENCE ?? "weekly"})...`);
const result = await runDropBatch();
console.log(
  `[force-match-batch] batch result: eligible=${result.eligible} pairs=${result.pairs} missed=${result.missedUserIds.length}`,
);

if (result.expiredMatches.length > 0) {
  console.log(`[force-match-batch] expiry preflight expired ${result.expiredMatches.length} stale match(es)`);
  const notify = await sendExpiryNotifications(bot.api, result.expiredMatches);
  console.log(
    `[force-match-batch] expiry notify: notified=${notify.notified} skipped=${notify.skipped} failed=${notify.failed}`,
  );
}

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
