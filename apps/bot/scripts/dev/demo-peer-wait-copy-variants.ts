/**
 * Dev-only: send THREE candidate rewrites of the peer-wait shimmer copy
 * (PRODUCT_SPEC §3.6b) into a Telegram chat for a founder review, each status
 * held ~20s. This is a PROPOSAL tool — it renders raw `<tg-thinking>` drafts
 * directly and does not touch `packages/shared/src/i18n.ts` or
 * `services/peer-wait.ts`. Nothing here ships until a variant is picked.
 *
 * The brief being tested: the shipped copy (`Ждём {name}`, `От {name} пока
 * тихо`, …) is too terse for a user who opens the chat several times an hour —
 * they can't tell WHAT is being waited on or WHY. Every candidate line below
 * therefore states the mechanic explicitly ("ждём ответа", "ждём решения")
 * rather than just naming the partner.
 *
 * Grammar note carried over from production: no line puts the partner's name
 * as the subject of a PAST-tense verb (ответила/выбрала), since Russian past
 * tense inflects by gender and the product deliberately avoids a gendered
 * ladder. Present/future tense ("отвечает", "ответит", "думает") and 1st-person
 * plural past ("напомнили", "передали") are gender-neutral and used instead.
 *
 * Only send methods are used (sendMessage + the rich draft API) — no DB, no
 * long polling, safe alongside `pnpm dev:bot`.
 *
 * Refuses to run unless DEV_OTP_BYPASS_TELEGRAM_IDS is set (prod keeps it
 * empty), so it can never fire against the production bot's audience.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/demo-peer-wait-copy-variants.ts [chatId]
 *   # default chatId = first DEV_OTP_BYPASS_TELEGRAM_IDS
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";
import { sendRichMessageDraft, thinkingHtml } from "../../src/services/telegram-rich.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("[demo-peer-wait-copy] BOT_TOKEN is not set");
  process.exit(1);
}

const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (bypass.length === 0) {
  console.error("[demo-peer-wait-copy] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS is empty (not a dev env)");
  process.exit(1);
}

const args = process.argv.slice(2);
const chatId = Number(args[0] ?? bypass[0]);
if (!Number.isFinite(chatId)) {
  console.error(`[demo-peer-wait-copy] invalid chat id: ${args[0]}`);
  process.exit(1);
}

const api = new Api(token);
const NAME = "Аня";
const HOLD_MS = 20_000;
const REISSUE_EVERY_MS = 4_000; // comfortably under the ~30s draft TTL
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CandidateState {
  tag: string; // e.g. "Тир 1 (< 5 мин)"
  line: string;
}

interface Variant {
  name: string;
  intro: string;
  states: CandidateState[];
}

const variants: Variant[] = [
  {
    name: "Вариант 1 — Прямой",
    intro:
      "Вариант 1/3 — «Прямой»: коротко и всегда называет механику (ждём ответа), " +
      "без лишних слов.",
    states: [
      { tag: "Тир 1 (< 5 мин)", line: `Передали ${NAME}, ждём ответа` },
      { tag: "Тир 2 (5 мин – 1 ч)", line: `Ждём ответа от ${NAME}` },
      { tag: "Тир 3 (1 – 6 ч)", line: `${NAME} пока не отвечает` },
      { tag: "Тир 4 (6 – 24 ч)", line: `Напомнили ${NAME} — ждём ответа` },
      { tag: "Тир 5 (> 24 ч)", line: `${NAME} всё ещё не отвечает, время поджимает` },
      { tag: "Календарь без пересечения", line: `Общего времени с ${NAME} пока нет` },
    ],
  },
  {
    name: "Вариант 2 — Разговорный",
    intro:
      "Вариант 2/3 — «Разговорный»: чуть теплее и живее, как будто бот лично держит " +
      "в курсе.",
    states: [
      { tag: "Тир 1 (< 5 мин)", line: `Всё передали ${NAME}, скоро узнаем ответ` },
      { tag: "Тир 2 (5 мин – 1 ч)", line: `${NAME} ещё думает над ответом` },
      { tag: "Тир 3 (1 – 6 ч)", line: `${NAME} пока молчит, ждём` },
      { tag: "Тир 4 (6 – 24 ч)", line: `Напомнили ${NAME} о вас, ждём ответа` },
      { tag: "Тир 5 (> 24 ч)", line: `${NAME} долго не отвечает, время поджимает` },
      { tag: "Календарь без пересечения", line: `Ваше время с ${NAME} не совпало` },
    ],
  },
  {
    name: "Вариант 3 — Пошаговый",
    intro:
      "Вариант 3/3 — «Пошаговый»: явно называет, на каком шаге вы находитесь " +
      "(«ждём решения», «ждём ответа»), чуть более развёрнуто.",
    states: [
      { tag: "Тир 1 (< 5 мин)", line: `Ход передан ${NAME}, ждём решения` },
      { tag: "Тир 2 (5 мин – 1 ч)", line: `Ждём, когда ответит ${NAME}` },
      { tag: "Тир 3 (1 – 6 ч)", line: `${NAME} думает уже больше часа` },
      { tag: "Тир 4 (6 – 24 ч)", line: `Напомнили ${NAME}, ждём ответа` },
      { tag: "Тир 5 (> 24 ч)", line: `${NAME} не отвечает больше суток, время поджимает` },
      { tag: "Календарь без пересечения", line: `У вас с ${NAME} выбрано разное время` },
    ],
  },
];

console.log(
  `[demo-peer-wait-copy] chat=${chatId} variants=${variants.length} statesPerVariant=${variants[0]!.states.length}`,
);

let draftIdCounter = 900_000_001;

for (const variant of variants) {
  await api.sendMessage(chatId, `— — — ${variant.name} — — —\n${variant.intro}`);

  for (const state of variant.states) {
    await api.sendMessage(chatId, state.tag);

    const draftId = draftIdCounter++;
    const until = Date.now() + HOLD_MS;
    while (Date.now() < until) {
      await sendRichMessageDraft(api, {
        chat_id: chatId,
        draft_id: draftId,
        rich_message: { html: thinkingHtml(state.line) },
      });
      await wait(REISSUE_EVERY_MS);
    }
  }
}

console.log("[demo-peer-wait-copy] done");
