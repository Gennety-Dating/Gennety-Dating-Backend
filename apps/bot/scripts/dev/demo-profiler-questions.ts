/**
 * Dev-only: show the NEW in-batch Profiler delivery (PRODUCT_SPEC §Phase 1b) in a
 * real Telegram chat — the experience a user gets *after answering* each question:
 *   1. a short self-replacing "thinking" status (✍️ ack → 💭 formulating,
 *      `profilerNextQuestionSteps`), deleted when done;
 *   2. the next question streamed in (typewriter reveal), the final chunk
 *      carrying the Skip button.
 *
 * This mirrors `sendQuestionStreamed` in `services/profiler.ts` exactly — same
 * primitives (`runStatusSequence` + `streamDraftsToChat`), same reveal shape —
 * so what you see here is what the bot sends in production.
 *
 * Only send methods are used (sendMessage / editMessageText / deleteMessage) —
 * no DB, no long polling, safe alongside a running `pnpm dev:bot`.
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set (prod keeps it empty),
 * so it can never fire against the production bot's audience.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/demo-profiler-questions.ts [chatId] [lang] [count] [slowFactor]
 *   # defaults: chatId = first DEV_OTP_BYPASS_TELEGRAM_IDS, lang = ru, count = 3, slowFactor = 1
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  t,
  type Language,
  profilerQuestionBank,
  profilerQuestionText,
  type ProfilerQuestion,
} from "@gennety/shared";
import { streamComposedRich } from "../../src/services/ai-stream.js";
import { profilerNextQuestionSteps } from "../../src/services/analysis-status.js";
import { PROFILER_SKIP_PREFIX } from "../../src/services/profiler.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("[demo-profiler] BOT_TOKEN is not set");
  process.exit(1);
}

const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (bypass.length === 0) {
  console.error(
    "[demo-profiler] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS is empty (not a dev env)",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const chatId = Number(args[0] ?? bypass[0]);
const lang = (args[1] ?? "ru") as Language;
const count = Math.max(1, Number(args[2] ?? "3"));
const slowFactor = Number(args[3] ?? "1");
if (!Number.isFinite(chatId)) {
  console.error(`[demo-profiler] invalid chat id: ${args[0]}`);
  process.exit(1);
}

const factor = Number.isFinite(slowFactor) && slowFactor > 0 ? slowFactor : 1;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms * factor)));

const api = new Api(token);

/** Mirrors `buildQuestionReveal` in services/profiler.ts. */
function buildQuestionReveal(text: string): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return [text];
  const cuts = [Math.ceil(words.length / 3), Math.ceil((2 * words.length) / 3)];
  const chunks: string[] = [];
  for (const cut of cuts) {
    const partial = `${words.slice(0, cut).join(" ")} …`;
    if (!chunks.includes(partial)) chunks.push(partial);
  }
  chunks.push(text);
  return chunks;
}

/** Mirrors `profilerSkipKeyboard` in services/profiler.ts. */
function skipKeyboard(questionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(lang, "profilerSkip"), callback_data: `${PROFILER_SKIP_PREFIX}${questionId}` }],
    ],
  };
}

async function deliver(question: ProfilerQuestion): Promise<void> {
  // Native Bot API 10.1 single-draft compose (matches production
  // `sendQuestionStreamed` follow-up): acknowledge → thinking shimmer + AI
  // Actions emoji, then the question streams in the SAME draft.
  await streamComposedRich(api, chatId, profilerNextQuestionSteps(lang), buildQuestionReveal(profilerQuestionText(question, lang)), {
    replyMarkup: skipKeyboard(question.id),
    wait,
  });
}

const bank = profilerQuestionBank("female");
const questions = bank.slice(0, Math.min(count, bank.length));

console.log(
  `[demo-profiler] chat=${chatId} lang=${lang} count=${questions.length} slowFactor=${factor}`,
);

await api.sendMessage(
  chatId,
  "🧪 Демо профайлера — так выглядит КАЖДЫЙ следующий вопрос после твоего ответа: " +
    "сначала статус-обдумывание, потом вопрос «печатается» и появляется кнопка «Пропустить». " +
    "(В демо ответы пропущены — показываю только реакцию бота.)",
);

for (const q of questions) {
  await wait(1200);
  await deliver(q);
}

await api.sendMessage(chatId, "✅ Готово. В бою такой ритм идёт между вопросами одного батча.");
console.log("[demo-profiler] done");
