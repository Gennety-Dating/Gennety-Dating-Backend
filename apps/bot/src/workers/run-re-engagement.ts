/**
 * Standalone script to run the re-engagement worker.
 * Intended to be invoked by a cron job or scheduler.
 *
 * Usage: npx tsx apps/bot/src/workers/run-re-engagement.ts
 */
import { Bot } from "grammy";
import { env } from "../config.js";
import { reEngagementTick } from "./re-engagement.js";

async function main(): Promise<void> {
  const bot = new Bot(env.BOT_TOKEN);
  const count = await reEngagementTick(bot.api);
  console.log(`Re-engagement tick complete: ${count} user(s) re-engaged.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Re-engagement worker failed:", err);
  process.exit(1);
});
