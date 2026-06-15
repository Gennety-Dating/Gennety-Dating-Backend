/**
 * Dev-only: send a NUMBERED preview of every animated custom emoji in a Telegram
 * pack (default AIActions) into a chat, so you can visually pick one for the
 * CUSTOM_EMOJI_AI_* / CUSTOM_EMOJI_THINKING_ID env slots. The pack's stickers are
 * all labelled 🙂, so `list-ai-emojis.ts` (ids only) isn't enough to choose — you
 * have to SEE them animate. Reply with the number you want and its id can be
 * read off the same line.
 *
 * Renders each glyph via the Bot API 10.1 rich `<tg-emoji>` tag (the same path
 * that already renders the thinking-block emoji), batched to stay well under the
 * per-message entity cap. Send-only, no DB, safe alongside `pnpm dev:bot`.
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set (prod keeps it empty).
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/preview-ai-emojis.ts [chatId] [setName]
 *   # defaults: chatId = first DEV_OTP_BYPASS_TELEGRAM_IDS, setName = AIActions
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";
import { sendRichMessage } from "../../src/services/telegram-rich.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("[preview-ai-emojis] BOT_TOKEN is not set");
  process.exit(1);
}

const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (bypass.length === 0) {
  console.error("[preview-ai-emojis] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS is empty (not a dev env)");
  process.exit(1);
}

const args = process.argv.slice(2);
const chatId = Number(args[0] ?? bypass[0]);
const setName = (args[1] ?? "AIActions").trim();
if (!Number.isFinite(chatId)) {
  console.error(`[preview-ai-emojis] invalid chat id: ${args[0]}`);
  process.exit(1);
}

const api = new Api(token);
const set = await api.getStickerSet(setName);
const ids = set.stickers.map((s) => s.custom_emoji_id).filter((x): x is string => Boolean(x));

console.log(`[preview-ai-emojis] chat=${chatId} set=${set.name} count=${ids.length}`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 8;

await api.sendMessage(
  chatId,
  `🎯 Превью пака «${set.title}» — ${ids.length} анимированных эмодзи, пронумерованы. ` +
    `Найди «поток звёзд» и пришли мне его номер (id указан в той же строке).`,
);

for (let start = 0; start < ids.length; start += CHUNK) {
  const lines = ids.slice(start, start + CHUNK).map((id, i) => {
    const n = start + i + 1;
    return `<b>${n})</b> <tg-emoji emoji-id="${id}">✨</tg-emoji>  <code>${id}</code>`;
  });
  try {
    await sendRichMessage(api, { chat_id: chatId, rich_message: { html: lines.join("\n") } });
  } catch (err) {
    console.error(`[preview-ai-emojis] rich send failed at chunk ${start}:`, err);
    break;
  }
  await wait(400);
}

console.log("[preview-ai-emojis] done");
