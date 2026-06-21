/**
 * Dev-only: fire the date-card **Share** progress status into a Telegram chat so
 * you can see how the new `dateCardShareSteps` sequence looks (PRODUCT_SPEC.md
 * §3.7a). Sends two back-to-back runs for comparison:
 *   1. the classic edited-line path — leading STAR glyphs (✨💫🌟⭐🌠), the look
 *      users now see in product flows;
 *   2. the Bot API 10.1 rich `<tg-thinking>` shimmer — which, with no
 *      CUSTOM_EMOJI_AI_SPARKLE_ID set, falls back to CUSTOM_EMOJI_THINKING_ID
 *      (the "cloud"), so you can see the current animated glyph and decide
 *      whether to source a real stars custom-emoji id.
 *
 * Only send methods are used (sendMessage / editMessageText / deleteMessage /
 * explicit rich draft for demo #2) — no DB, no long polling, safe alongside
 * `pnpm dev:bot`.
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set (prod keeps it empty),
 * so it can never fire against the production bot's audience.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/demo-share-status.ts [chatId] [lang] [slowFactor]
 *   # defaults: chatId = first DEV_OTP_BYPASS_TELEGRAM_IDS, lang = ru, slowFactor = 1.8
 *   # slowFactor stretches each step's hold so you can read every status.
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";
import type { Language } from "@gennety/shared";
import { runStatusSequence } from "../../src/services/ai-stream.js";
import { dateCardShareSteps } from "../../src/services/analysis-status.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("[demo-share-status] BOT_TOKEN is not set");
  process.exit(1);
}

const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (bypass.length === 0) {
  console.error(
    "[demo-share-status] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS is empty (not a dev env)",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const chatId = Number(args[0] ?? bypass[0]);
const lang = (args[1] ?? "ru") as Language;
const slowFactor = Number(args[2] ?? "1.8");
if (!Number.isFinite(chatId)) {
  console.error(`[demo-share-status] invalid chat id: ${args[0]}`);
  process.exit(1);
}

const api = new Api(token);
const steps = dateCardShareSteps(lang);

// Stretch each step's hold so every status is comfortably readable in the demo.
// Production timings live in `dateCardShareSteps`; this only slows the preview.
const factor = Number.isFinite(slowFactor) && slowFactor > 0 ? slowFactor : 1.8;
const slowWait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms * factor)));

console.log(
  `[demo-share-status] chat=${chatId} lang=${lang} steps=${steps.length} slowFactor=${factor}`,
);

// 1) Classic edited-line path — leading star glyphs, final line kept on screen.
await api.sendMessage(
  chatId,
  "🧪 Демо 1/2 — статусы «Поделиться» (классическая строка, звёзды ✨). Смотри, как одна строка перебирает 4 статуса:",
);
await runStatusSequence(api, chatId, steps, { rich: false, deleteAtEnd: false, wait: slowWait });

// 2) Explicit rich <tg-thinking> shimmer — dev-only comparison path.
await api.sendMessage(
  chatId,
  "🧪 Демо 2/2 — тот же набор в rich-шиммере (сейчас ведёт «облачко», т.к. " +
    "CUSTOM_EMOJI_AI_SPARKLE_ID не задан):",
);
await runStatusSequence(api, chatId, steps, { rich: true, deleteAtEnd: false, wait: slowWait });

await api.sendMessage(
  chatId,
  "✅ Готово. В бою статус держится, пока рендерится PNG, и убирается перед отправкой карточки.",
);

console.log("[demo-share-status] done");
