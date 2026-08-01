#!/usr/bin/env node
/**
 * Dev-only helper (local DEV bot only).
 *
 * Renders EVERY card in the pre-date coordination family
 * (`apps/bot/src/services/coordination-card`, PRODUCT_SPEC §Phase 4) and DMs
 * them one by one, each captioned with the exact moment it fires — a design
 * review surface for the whole flow in one pass.
 *
 * Pure render + send: it touches no database, stages no match, and calls no
 * production handler, so it is safe to re-run as often as you like while
 * iterating on the layout. The cards are NOT wired into the live coordination
 * DMs yet — that is the follow-up step once the design is settled.
 *
 * Usage (sends the five RU dark cards to the default dev chat):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-coord-cards-demo.mjs
 *
 * Options:
 *   --chat=782065541      who receives them
 *   --lang=ru|en|uk|de|pl card language (default ru)
 *   --theme=dark|light|both   (default dark)
 *   --only=shared,proxy   render a subset
 *   --out=./tmp/cards     also write the PNGs to disk
 *   --no-send             render (and optionally --out) without DMing
 *   --force               bypass the gennetytestbot guard
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
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.slice(2).split("=");
    return [k, v];
  }),
);
const chatId = Number(argv.get("chat") ?? "782065541");
const lang = argv.get("lang") ?? "ru";
const themeArg = argv.get("theme") ?? "dark";
const themes = themeArg === "both" ? ["dark", "light"] : [themeArg];
const only = argv.get("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const outDir = argv.get("out") ?? null;
const send = argv.get("no-send") !== "true";
const force = argv.get("force") === "true";

/**
 * One entry per real send in the flow. `photo` is a bundled brand portrait so
 * the demo needs no seeded profile and no network — the production caller
 * passes a `personPhotoRef` (Telegram file_id / Supabase path) instead.
 */
const SCENARIOS = [
  {
    id: "offer",
    photo: "1.jpg",
    input: { variant: "offer", personName: "Максим" },
    caption:
      "1/5 · T-60 мин — предложение выбрать способ координации.\nПолучает инициатор (девушка). В кадре — партнёр.",
  },
  {
    id: "ask",
    photo: "2.jpg",
    input: { variant: "ask", personName: "Алина" },
    caption:
      "2/5 · Вариант B — у партнёра спрашивают согласие поделиться Telegram.\nПолучает парень. В кадре — та, кто просит. Под карточкой — зелёная «Поделиться» и красная «Не сейчас».",
  },
  {
    id: "shared",
    photo: "3.jpg",
    input: { variant: "shared", personName: "Максим", handle: "@maksym" },
    caption:
      "3/5 · Контакт открыт — вариант A (она поделилась сама) и вариант B после согласия.\nВ кадре — владелец контакта, под заголовком — сам @юзернейм.",
  },
  {
    id: "declined",
    photo: null,
    input: { variant: "declined", personName: "Максим" },
    caption:
      "4/5 · Отказ поделиться контактом.\nФото намеренно нет — карточка не про человека, а про решение. Часы = «не сейчас, но за 30 мин откроется анонимный чат».",
  },
  {
    id: "proxy",
    photo: null,
    input: { variant: "proxy", personName: "Максим" },
    caption:
      "5/5 · Анонимный чат открыт (T-30 мин), получают оба.\nТа же рамка полароида, но портрет намеренно скрыт растром — это и есть анонимность.",
  },
];

function portrait(file) {
  if (!file) return null;
  const path = resolve(root, "apps/bot/src/assets/referral-portraits", file);
  return existsSync(path) ? readFileSync(path) : null;
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      `Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force to override.`,
    );
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  // Resolve grammy against apps/bot (its dep, not the root's) so the InputFile
  // we construct is the same class identity the Api instance expects.
  const requireFromBot = createRequire(resolve(root, "apps/bot/package.json"));
  const { Bot, InputFile } = await import(requireFromBot.resolve("grammy"));
  const { renderCoordinationCard } = await import(
    "../apps/bot/src/services/coordination-card/index.js"
  );

  const api = new Bot(process.env.BOT_TOKEN).api;
  if (outDir) mkdirSync(resolve(root, outDir), { recursive: true });

  const picked = SCENARIOS.filter((s) => !only || only.includes(s.id));
  if (picked.length === 0) throw new Error(`--only matched nothing. Known ids: ${SCENARIOS.map((s) => s.id).join(", ")}`);

  for (const theme of themes) {
    if (send && themes.length > 1) {
      await api.sendMessage(chatId, `——— тема: ${theme} ———`);
    }
    for (const scenario of picked) {
      const started = Date.now();
      const png = await renderCoordinationCard(
        { ...scenario.input, language: lang, theme, personPhoto: portrait(scenario.photo) },
        api,
      );
      if (!png) {
        console.warn(`✗ ${scenario.id} (${theme}) — render returned null`);
        continue;
      }
      console.log(
        `✔ ${scenario.id} (${theme}/${lang}) — ${(png.length / 1024).toFixed(0)} KB in ${Date.now() - started}ms`,
      );

      if (outDir) {
        const file = resolve(root, outDir, `coord-${scenario.id}-${theme}-${lang}.png`);
        writeFileSync(file, png);
        console.log(`  → ${file}`);
      }
      if (send) {
        await api.sendPhoto(chatId, new InputFile(png, `coord-${scenario.id}.png`), {
          caption: scenario.caption,
        });
        // Telegram is happy well above this; the pause is purely so the cards
        // land in order and read as a sequence in the chat.
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }

  if (send) console.log(`\n=== SENT === ${picked.length * themes.length} card(s) → chat ${chatId}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
