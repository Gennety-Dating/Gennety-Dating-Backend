#!/usr/bin/env node
/**
 * Dev-only helper (local DEV bot only).
 *
 * Renders every variant of the proposal-expiry card (PRODUCT_SPEC §3.4 — the
 * 24h decision window closing) and DMs them so the mockups can be judged in a
 * real Telegram chat at real size, next to the text they'd replace.
 *
 * Pure render + send: no database, no match seeding, no state written
 * anywhere. Safe to re-run as often as you like while iterating on the design.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-expiry-cards-demo.mjs
 * Optional:
 *   --tg=782065541      recipient chat id
 *   --theme=dark|light|both   (default: both — dark individually, light as an album)
 *   --out=./tmp         also write the PNGs to disk
 *   --force             bypass the dev-bot guard
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const argv = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);
const force = argv.get("force") === "true";
const chatId = Number(argv.get("tg") ?? "782065541");
const themeArg = argv.get("theme") ?? "both";
const outDir = argv.get("out");

/**
 * Mockup copy. Deliberately NOT wired to i18n yet — the point of this pass is
 * to agree on the visual system and the tone; the strings move into
 * `packages/shared/src/i18n.ts` (all five locales) once the design is signed
 * off. Each entry maps 1:1 onto a branch of §3.4's expiry asymmetry.
 */
const CARDS = [
  {
    key: "expired",
    variant: "expired",
    overline: "ОКНО ЗАКРЫТО",
    headline: "ВРЕМЯ\nВЫШЛО",
    subline: "Ты не ответил за 24 часа.\nЖдём тебя в следующем дропе.",
    caption:
      "1/4 — <b>Молчание, первое предупреждение</b>\n" +
      "Пользователь не ответил на пич за 24 часа, партнёр ответил. " +
      "Рейтинг пока не тронут — только предупреждение.\n\n" +
      "<i>Сейчас вместо этого: сухой текст «Time's up — you didn't reply to your match in 24h.»</i>",
  },
  {
    key: "penalty",
    variant: "penalty",
    overline: "ВТОРОЙ РАЗ БЕЗ ОТВЕТА",
    headline: "РЕЙТИНГ\nПОНИЖЕН",
    subline: "Игнорировать пару — неуважительно.\nМы понизили твой рейтинг.",
    caption:
      "2/4 — <b>Молчание повторно, штраф применён</b>\n" +
      "Второй и последующие разы: Elo реально понижен (forgive-once уже потрачен).\n\n" +
      "<i>Мотив — падающие столбцы: единственная карточка, где «что-то ушло вниз» показано буквально.</i>",
  },
  {
    key: "peer_ignored",
    variant: "peer_ignored",
    overline: "ЭТО НЕ ПРО ТЕБЯ",
    headline: "ПАРА НЕ\nОТВЕТИЛА",
    subline: "Свидание не состоится.\nТвой приоритет в следующем дропе повышен.",
    caption:
      "3/4 — <b>Ответил ты, промолчали они</b>\n" +
      "Единственный сценарий, где пользователь ни в чём не виноват — тон сочувственный, " +
      "и мы сразу говорим про компенсацию приоритетом.\n\n" +
      "<i>Мотив: твой круг закрыт галочкой, их — пунктирный и пустой.</i>",
  },
  {
    key: "missed_date",
    variant: "missed_date",
    overline: "ТЕБЕ СКАЗАЛИ ДА",
    headline: "ТЫ УПУСТИЛ\nСВИДАНИЕ",
    subline: "Пара была готова встретиться.\nТы не ответил за 24 часа.",
    caption:
      "4/4 — <b>Ты промолчал, а тебе сказали ДА</b>\n" +
      "Самый заряженный момент во всём флоу. В коде это приставка " +
      "<code>matchExpiredYouMissedDate</code> поверх карточки 1 или 2 — " +
      "то есть эта карточка заменяет собой пару.\n\n" +
      "<i>Мотив: сердце, разъехавшееся надвое — одна половина сплошная (их «да» было настоящим), вторая пустая.</i>",
  },
];

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      `Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force to override.`,
    );
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  // Resolve grammy against apps/bot (it's the bot's dep, not the root's) so the
  // InputFile we build shares one module identity with the bot's own.
  const requireFromBot = createRequire(resolve(root, "apps/bot/package.json"));
  const { Bot, InputFile } = await import(requireFromBot.resolve("grammy"));
  const { renderExpiryCard } = await import("../apps/bot/src/services/expiry-card.js");

  const api = new Bot(process.env.BOT_TOKEN).api;
  if (outDir) mkdirSync(resolve(root, outDir), { recursive: true });

  const wantDark = themeArg === "dark" || themeArg === "both";
  const wantLight = themeArg === "light" || themeArg === "both";

  if (wantDark) {
    await api.sendMessage(
      chatId,
      "🎴 <b>Карточки истечения дедлайна — макеты</b>\n\n" +
        "Четыре сценария из PRODUCT_SPEC §3.4. Тёмная тема (дефолт продукта) — " +
        "по одной, со сценарием в подписи. Ниже придёт та же серия в светлой.",
      { parse_mode: "HTML" },
    );
  }

  for (const card of CARDS) {
    if (!wantDark) break;
    const png = await renderExpiryCard({
      variant: card.variant,
      overline: card.overline,
      headline: card.headline,
      subline: card.subline,
      theme: "dark",
    });
    if (!png) {
      console.error(`  ✗ ${card.key} (dark): render returned null`);
      continue;
    }
    if (outDir) writeFileSync(resolve(root, outDir, `expiry-${card.key}-dark.png`), png);
    await api.sendPhoto(chatId, new InputFile(png, `expiry-${card.key}-dark.png`), {
      caption: card.caption,
      parse_mode: "HTML",
    });
    console.log(`  ✓ ${card.key} (dark) — ${(png.length / 1024).toFixed(0)} KB`);
  }

  if (wantLight) {
    const media = [];
    for (const card of CARDS) {
      const png = await renderExpiryCard({
        variant: card.variant,
        overline: card.overline,
        headline: card.headline,
        subline: card.subline,
        theme: "light",
      });
      if (!png) {
        console.error(`  ✗ ${card.key} (light): render returned null`);
        continue;
      }
      if (outDir) writeFileSync(resolve(root, outDir, `expiry-${card.key}-light.png`), png);
      media.push({
        type: "photo",
        media: new InputFile(png, `expiry-${card.key}-light.png`),
        ...(media.length === 0
          ? {
              caption:
                "☀️ <b>Светлая тема</b> — та же серия, тот же порядок.\n" +
                "Карточка всегда рендерится в теме получателя (<code>User.theme</code>), как дата-карточка и тайм-карточка.",
              parse_mode: "HTML",
            }
          : {}),
      });
      console.log(`  ✓ ${card.key} (light) — ${(png.length / 1024).toFixed(0)} KB`);
    }
    if (media.length) await api.sendMediaGroup(chatId, media);
  }

  console.log(`\nSent to chat ${chatId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
