/**
 * Dev-only: arm a clean Profiler batch for the dev chat and send the FIRST
 * question (streamed), so you can answer interactively in @gennetytestbot and
 * watch each NEXT question stream in via the live bot (PRODUCT_SPEC §Phase 1b).
 *
 * Requires the live dev bot to be running on CURRENT code (the streaming lives
 * in `recordProfilerAnswer` → `sendQuestionStreamed`).
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set (prod keeps it empty).
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/arm-profiler-demo.ts [chatId] [lang] [remaining]
 *   # defaults: chatId = first bypass id, lang = ru, remaining = 4
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
} from "@gennety/shared";
import { streamComposedRich } from "../../src/services/ai-stream.js";
import { profilerOpenQuestionSteps } from "../../src/services/analysis-status.js";
import { PROFILER_SKIP_PREFIX } from "../../src/services/profiler.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const { prisma } = await import("@gennety/db");

const token = process.env.BOT_TOKEN ?? "";
const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!token || bypass.length === 0) {
  console.error("[arm] need BOT_TOKEN + non-empty DEV_OTP_BYPASS_TELEGRAM_IDS (dev only)");
  process.exit(1);
}

const args = process.argv.slice(2);
const tgId = BigInt(String(args[0] ?? bypass[0]));
const lang = (args[1] ?? "ru") as Language;
const remaining = Math.max(1, Number(args[2] ?? "4"));

const user = await prisma.user.findUnique({
  where: { telegramId: tgId },
  select: { id: true, gender: true },
});
if (!user) {
  console.error(`[arm] no dev user for telegramId ${String(tgId)}`);
  process.exit(1);
}

const bank = profilerQuestionBank(user.gender ?? "female");
const first = bank[0]!;

// Clean, predictable run: wipe prior answers, re-arm a fresh batch.
await prisma.profilerAnswer.deleteMany({ where: { userId: user.id } });
await prisma.profile.update({
  where: { userId: user.id },
  data: {
    profilerActiveQuestionId: first.id,
    profilerBatchRemaining: remaining,
    profilerNextAt: null,
    profilerStartedAt: new Date(),
  },
});

// Ensure the grammY session is completed + idle so the profiler router captures
// the reply (read() merges DEFAULT_SESSION, so storing the overrides suffices).
const sess = await prisma.botSession.findUnique({ where: { key: String(tgId) } });
const base = (sess?.data as Record<string, unknown> | undefined) ?? {};
await prisma.botSession.upsert({
  where: { key: String(tgId) },
  create: {
    key: String(tgId),
    data: { onboardingStep: "completed", language: lang, matchFlow: "idle", menuState: "idle" },
  },
  update: {
    data: {
      ...base,
      onboardingStep: "completed",
      matchFlow: "idle",
      menuState: "idle",
      expectingPhoto: false,
      awaitingContextDump: false,
    },
  },
});

const api = new Api(token);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function reveal(text: string): string[] {
  const w = text.trim().split(/\s+/);
  if (w.length < 3) return [text];
  const cuts = [Math.ceil(w.length / 3), Math.ceil((2 * w.length) / 3)];
  const c: string[] = [];
  for (const x of cuts) {
    const p = `${w.slice(0, x).join(" ")} …`;
    if (!c.includes(p)) c.push(p);
  }
  c.push(text);
  return c;
}
function kb(id: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: t(lang, "profilerSkip"), callback_data: `${PROFILER_SKIP_PREFIX}${id}` }]] };
}

await api.sendMessage(
  Number(tgId),
  "🧪 Интерактив профайлера. Ответь на вопрос ниже — следующий придёт со стримингом. " +
    "Так по кругу несколько раз; потом увидишь «Карточку обновлена».",
);
// Native Bot API 10.1 single-draft compose (identical to production
// `sendQuestionStreamed` for the batch opener): one <tg-thinking> "thinking"
// shimmer beat, then the question streams in the same draft, finalised with the
// Skip keyboard. Subsequent questions are streamed by the live bot as you answer.
await streamComposedRich(api, Number(tgId), profilerOpenQuestionSteps(lang), reveal(profilerQuestionText(first, lang)), {
  replyMarkup: kb(first.id),
  wait,
});

console.log(`[arm] user=${user.id} active=${first.id} remaining=${remaining} lang=${lang}; first question sent.`);
await prisma.$disconnect();
