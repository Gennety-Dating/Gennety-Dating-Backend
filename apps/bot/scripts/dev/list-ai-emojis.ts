/**
 * Dev-only: list the custom-emoji ids of a Telegram emoji pack (default
 * AIActions, https://t.me/addemoji/AIActions) so you can pick ids for the
 * CUSTOM_EMOJI_THINKING_ID / CUSTOM_EMOJI_AI_* env slots that lead the rich
 * "thinking" progress beats (the shine shimmer on the date-card render etc.).
 *
 * Read-only Telegram call (getStickerSet) — no DB, no long polling, safe with
 * either bot token.
 *
 * Usage: pnpm tsx apps/bot/scripts/dev/list-ai-emojis.ts [setName]
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("[list-ai-emojis] BOT_TOKEN is not set");
  process.exit(1);
}

const setName = (process.argv[2] ?? "AIActions").trim();
const api = new Api(token);

const set = await api.getStickerSet(setName);
console.log(
  `\n${set.title} (${set.name}) — ${set.stickers.length} stickers, type=${set.sticker_type}\n`,
);
for (const s of set.stickers) {
  // Custom-emoji packs carry `custom_emoji_id`; that's the id env slots want.
  console.log(`  ${s.emoji ?? "  "}  ${s.custom_emoji_id ?? "(no custom_emoji_id)"}`);
}
