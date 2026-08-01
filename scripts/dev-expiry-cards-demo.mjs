#!/usr/bin/env node
/**
 * Dev-only helper (local DEV bot only).
 *
 * Renders every variant of the proposal-expiry card (PRODUCT_SPEC §3.4 — the
 * 24h decision window closing) and DMs them, so the real thing can be judged
 * in a real Telegram chat at real size.
 *
 * Copy comes from `@gennety/shared` i18n, exactly as production reads it — a
 * demo with its own hardcoded strings drifts from the product within a week.
 * Every card here is therefore also a check that its 15 keys exist in the
 * requested locale.
 *
 * Pure render + send: no database, no match seeding, no state written
 * anywhere. Safe to re-run as often as you like.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-expiry-cards-demo.mjs
 * Optional:
 *   --tg=782065541            recipient chat id
 *   --lang=ru|en|uk|de|pl|all which locale(s) to render (default: ru)
 *   --theme=dark|light|both   (default: both — dark individually, light as an album)
 *   --out=./tmp               also write the PNGs to disk
 *   --no-send                 render only (pairs well with --out)
 *   --force                   bypass the dev-bot guard
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
const send = argv.get("no-send") !== "true";
const chatId = Number(argv.get("tg") ?? "782065541");
const themeArg = argv.get("theme") ?? "both";
const langArg = argv.get("lang") ?? "ru";
const outDir = argv.get("out");

const ALL_LANGS = ["en", "ru", "uk", "de", "pl"];
const langs = langArg === "all" ? ALL_LANGS : [langArg];

/**
 * The four branches of §3.4's expiry asymmetry. `caption` names the caption key
 * that production pairs with this card — note `missed_date` takes the warning
 * or penalty caption underneath it, since the card is a visual override only.
 */
const VARIANTS = [
  {
    variant: "expired",
    suffix: "Expired",
    caption: "expiryCaptionSilentWarning",
    note:
      "1/4 — <b>Молчание, первое предупреждение</b>\n" +
      "Не ответил за 24 часа, партнёр ответил. Рейтинг не тронут.",
  },
  {
    variant: "penalty",
    suffix: "Penalty",
    caption: "expiryCaptionSilentPenalty",
    note:
      "2/4 — <b>Молчание повторно, штраф применён</b>\n" +
      "Elo реально понижен. Карточка рисуется только если списание прошло — " +
      "иначе остаётся вариант 1.",
  },
  {
    variant: "peer_ignored",
    suffix: "PeerIgnored",
    caption: "expiryCaptionPeerIgnored",
    note:
      "3/4 — <b>Ответил ты, промолчали они</b>\n" +
      "Единственный сценарий без вины пользователя. Приоритет здесь " +
      "<b>не обещаем</b> — expiry-путь его не начисляет.",
  },
  {
    variant: "missed_date",
    suffix: "MissedDate",
    caption: "expiryCaptionSilentWarning",
    note:
      "4/4 — <b>Ты промолчал, а тебе сказали ДА</b>\n" +
      "Визуально заменяет карточку 1 или 2, но подпись остаётся от них — " +
      "то есть штраф всё равно проговаривается.",
  },
];

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      `Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force to override.`,
    );
  }
  if (send && !process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  // Resolve grammy against apps/bot (it's the bot's dep, not the root's) so the
  // InputFile we build shares one module identity with the bot's own.
  const requireFromBot = createRequire(resolve(root, "apps/bot/package.json"));
  const { Bot, InputFile } = await import(requireFromBot.resolve("grammy"));
  const { renderExpiryCard } = await import("../apps/bot/src/services/expiry-card.js");
  const { t } = await import("@gennety/shared");

  const api = send ? new Bot(process.env.BOT_TOKEN).api : null;
  if (outDir) mkdirSync(resolve(root, outDir), { recursive: true });

  const wantDark = themeArg === "dark" || themeArg === "both";
  const wantLight = themeArg === "light" || themeArg === "both";

  const render = (v, lang, theme) =>
    renderExpiryCard({
      variant: v.variant,
      overline: t(lang, `expiryCardOverline${v.suffix}`),
      headline: t(lang, `expiryCardHeadline${v.suffix}`),
      subline: t(lang, `expiryCardSubline${v.suffix}`),
      theme,
    });

  for (const lang of langs) {
    if (send && wantDark) {
      await api.sendMessage(
        chatId,
        `🎴 <b>Карточки истечения дедлайна — ${lang.toUpperCase()}</b>\n\n` +
          "Четыре сценария из PRODUCT_SPEC §3.4. Подпись под каждой — настоящая, " +
          "из i18n: карточка говорит <i>что произошло</i>, подпись добавляет " +
          "<i>только последствие</i>.",
        { parse_mode: "HTML" },
      );
    }

    for (const v of VARIANTS) {
      if (!wantDark) break;
      const png = await render(v, lang, "dark");
      if (!png) {
        console.error(`  ✗ ${lang}/${v.variant} (dark): render returned null`);
        continue;
      }
      if (outDir) writeFileSync(resolve(root, outDir, `expiry-${lang}-${v.variant}-dark.png`), png);
      if (send) {
        await api.sendPhoto(chatId, new InputFile(png, `expiry-${v.variant}.png`), {
          caption: `${v.note}\n\n<b>Подпись в проде:</b> <i>${t(lang, v.caption)}</i>`,
          parse_mode: "HTML",
        });
      }
      console.log(`  ✓ ${lang}/${v.variant} (dark) — ${(png.length / 1024).toFixed(0)} KB`);
    }

    if (!wantLight) continue;
    const media = [];
    for (const v of VARIANTS) {
      const png = await render(v, lang, "light");
      if (!png) {
        console.error(`  ✗ ${lang}/${v.variant} (light): render returned null`);
        continue;
      }
      if (outDir) writeFileSync(resolve(root, outDir, `expiry-${lang}-${v.variant}-light.png`), png);
      media.push({
        type: "photo",
        media: new InputFile(png, `expiry-${v.variant}-light.png`),
        ...(media.length === 0
          ? {
              caption:
                `☀️ <b>Светлая тема — ${lang.toUpperCase()}</b>, тот же порядок.\n` +
                "Карточка всегда рендерится в теме получателя (<code>User.theme</code>).",
              parse_mode: "HTML",
            }
          : {}),
      });
      console.log(`  ✓ ${lang}/${v.variant} (light) — ${(png.length / 1024).toFixed(0)} KB`);
    }
    if (send && media.length) await api.sendMediaGroup(chatId, media);
  }

  console.log(send ? `\nSent to chat ${chatId}.` : "\nRendered only (--no-send).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
