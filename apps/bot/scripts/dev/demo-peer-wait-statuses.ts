/**
 * Dev-only: walk through every peer-wait shimmer status (PRODUCT_SPEC §3.6b) in
 * a Telegram chat, one at a time — a caption explaining WHERE it fires and its
 * time window, then the actual `<tg-thinking>` draft held on screen for ~20s
 * before moving to the next.
 *
 * A rich draft dies ~30s after it's issued, so "held for 20s" here means
 * re-issuing the same draft_id every ~4s — the same mechanism
 * `workers/peer-wait-shimmer.ts` uses to keep one alive for hours in production.
 *
 * Only send methods are used (sendMessage + the rich draft API) — no DB, no
 * long polling, safe alongside `pnpm dev:bot`.
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set (prod keeps it
 * empty), so it can never fire against the production bot's audience.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/demo-peer-wait-statuses.ts [chatId] [lang]
 *   # defaults: chatId = first DEV_OTP_BYPASS_TELEGRAM_IDS, lang = ru
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";
import type { Language } from "@gennety/shared";
import { issuePeerWaitDraft } from "../../src/services/peer-wait.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("[demo-peer-wait] BOT_TOKEN is not set");
  process.exit(1);
}

const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (bypass.length === 0) {
  console.error("[demo-peer-wait] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS is empty (not a dev env)");
  process.exit(1);
}

const args = process.argv.slice(2);
const chatId = Number(args[0] ?? bypass[0]);
const lang = (args[1] ?? "ru") as Language;
if (!Number.isFinite(chatId)) {
  console.error(`[demo-peer-wait] invalid chat id: ${args[0]}`);
  process.exit(1);
}

const api = new Api(token);
const MATCH_ID = "demo-peer-wait";
const SIDE = "A" as const;
const HOLD_MS = 20_000;
const REISSUE_EVERY_MS = 4_000; // comfortably under the ~30s draft TTL

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface DemoStep {
  startedAgoMs: number;
  caption: string;
}

const HOUR = 60 * 60 * 1000;

const steps: DemoStep[] = [
  {
    startedAgoMs: 0,
    caption:
      "1/5 — Тир 1 (< 5 мин). Появляется СРАЗУ, как только пользователь принял свою сторону " +
      "(питч — accept), первым выбрал слоты в календаре, подтвердил вайб/место, или лайкнул/оплатил " +
      "на доске смены места. Держится до 5-й минуты ожидания.",
  },
  {
    startedAgoMs: 10 * 60 * 1000,
    caption: "2/5 — Тир 2 (5 мин – 1 ч). Партнёр всё ещё не ответил.",
  },
  {
    startedAgoMs: 2 * HOUR,
    caption: "3/5 — Тир 3 (1 ч – 6 ч). Партнёр молчит дольше часа.",
  },
  {
    startedAgoMs: 7 * HOUR,
    caption:
      "4/5 — Тир 4 (6 ч – 24 ч). На 6-м часу реально уходит напоминание партнёру " +
      "(match-nudge, §3.5) — эта строка появляется РОВНО тогда, когда нудж уже отправлен.",
  },
  {
    startedAgoMs: 25 * HOUR,
    caption:
      "5/5 — Тир 5 (> 24 ч). На 24-м часу уходит check-in «ещё в силе?» (§3.5c), а на 48-м — " +
      "матч отменяется. Эта строка держится в этом окне.\n\n" +
      "Отдельно: когда оба выбрали слоты и они НЕ пересеклись — статуса нет ни у кого. " +
      "Там ход снова за обоими, поэтому уходит напоминание с кнопкой календаря, а не шиммер.",
  },
];

console.log(`[demo-peer-wait] chat=${chatId} lang=${lang} steps=${steps.length}`);

for (const step of steps) {
  await api.sendMessage(chatId, step.caption);

  const startedAt = new Date(Date.now() - step.startedAgoMs);
  const until = Date.now() + HOLD_MS;
  while (Date.now() < until) {
    await issuePeerWaitDraft(api, {
      chatId,
      matchId: MATCH_ID,
      side: SIDE,
      lang,
      partnerName: "Аня",
      startedAt,
      now: new Date(),
    });
    await wait(REISSUE_EVERY_MS);
  }
}

console.log("[demo-peer-wait] done");
