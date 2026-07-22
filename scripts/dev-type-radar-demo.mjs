#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot + localhost dev DB only).
 *
 * Sends YOU the exact Type Radar onboarding invite that production sends a user
 * mid-onboarding, right before the Magic Prompt / photos step (§Type Radar,
 * step 5B). It reuses the real production send path `sendTypeRadarInvite(...)`,
 * so the message body, the `web_app` "Choose my type" button (opening
 * radar.html with the viewer's lang+theme), the inline "Skip for now" button,
 * and the callback data (`radar:skip`) are byte-for-byte what a real user gets.
 *
 * This does NOT run the onboarding agent — it hands you the finished invite so
 * you can open the picker and go through it as a user. To actually load the
 * deck + submit from the Mini App you additionally need (see the printed notes):
 *   • TYPE_RADAR_ENABLED=true in .env.local, then restart `pnpm dev:bot`
 *     (otherwise /v1/radar/deck + /submit 404 and the picker can't load),
 *   • the tester account has age (≤ 28 → band A, the only live band) + a gender
 *     preference set (the deck derives band from age, set(s) from preference),
 *   • WEBAPP_URL is a real HTTPS host served by `pnpm dev:webapp` (the ngrok
 *     tunnel in .env.local), else the web_app button is omitted and only Skip
 *     shows — exactly as the production code degrades without a tunnel.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-type-radar-demo.mjs --to=<tester tg> [--lang=ru]
 *
 * The tester must have pressed Start on @gennetytestbot at least once (a bot
 * can't initiate a chat). --lang, when given, also updates that account's
 * `language` in the dev DB so the whole message (text + button + picker URL) is
 * consistently that language, mirroring a real user of that locale.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

const force = args.get("force") === "true";
const toTg = BigInt(args.get("to") ?? args.get("a") ?? "782065541");
const langOverride = args.get("lang");
const SUPPORTED_LANGS = new Set(["en", "ru", "uk", "de", "pl"]);

/**
 * Minimal Bot API wrapper (same shape as dev-calendar-solo-demo). It only needs
 * `sendMessage(chatId, text, options)`; a grammY `InlineKeyboard` passed as
 * `reply_markup` JSON-serializes to `{ inline_keyboard: [...] }`, which is a
 * valid Bot API object — so this drives the real `sendTypeRadarInvite` unchanged
 * without importing grammY from scripts/ (which can't resolve it).
 */
function createTelegramApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, payload) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const description = json?.description ?? `${res.status} ${res.statusText}`;
      throw new Error(`Telegram ${method} failed: ${description}`);
    }
    return json.result;
  }
  return {
    sendMessage: (chatId, text, options = {}) =>
      call("sendMessage", { chat_id: chatId, text, ...options }),
  };
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      "Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Pass --force to override.",
    );
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error(
      "Refusing to run outside the local localhost:5434/gennety_dev database. Pass --force to override.",
    );
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");
  if (langOverride && !SUPPORTED_LANGS.has(langOverride)) {
    throw new Error(`--lang must be one of: ${[...SUPPORTED_LANGS].join(", ")}`);
  }

  const { prisma } = await import("@gennety/db");
  const { sendTypeRadarInvite } = await import(
    "../apps/bot/src/handlers/onboarding/type-radar.js"
  );
  const { typeRadarInviteCopy } = await import(
    "../apps/bot/src/services/type-radar-copy.js"
  );

  const user = await prisma.user.findUnique({
    where: { telegramId: toTg },
    select: { id: true, firstName: true, language: true, theme: true, age: true, preference: true },
  });
  if (!user) {
    console.warn(
      `⚠️  No account with tg=${toTg} in the dev DB — sending with the en/dark fallback ` +
      "(the message still goes through; only the Mini App deck needs a full account).",
    );
  }

  // Keep the whole message consistent in one locale when --lang is passed.
  if (langOverride && user && user.language !== langOverride) {
    await prisma.user.update({ where: { id: user.id }, data: { language: langOverride } });
    console.log(`Set dev account language → ${langOverride} for a consistent demo.`);
  }

  const lang = (langOverride ?? user?.language ?? "en");
  const copy = typeRadarInviteCopy(lang);

  // The exact production send path: intro copy body + web_app + Skip buttons.
  const api = createTelegramApi(process.env.BOT_TOKEN);
  let sendError = null;
  try {
    await sendTypeRadarInvite(api, Number(toTg), toTg, copy.intro);
  } catch (err) {
    sendError = err;
  }

  const httpsHost =
    typeof process.env.WEBAPP_URL === "string" &&
    process.env.WEBAPP_URL.startsWith("https://");

  console.log("\n── RESULT ──");
  console.log(JSON.stringify({
    to: { tg: toTg.toString(), name: user?.firstName ?? null, age: user?.age ?? null, preference: user?.preference ?? null },
    language: lang,
    theme: user?.theme ?? "dark",
    message: {
      body: copy.intro,
      webAppButton: httpsHost ? copy.button : "(omitted — WEBAPP_URL is not https)",
      skipButton: copy.skip,
      skipCallback: "radar:skip",
      pickerUrl: httpsHost
        ? `${process.env.WEBAPP_URL.replace(/\/+$/, "")}/radar.html?lang=${lang}&theme=${user?.theme ?? "dark"}`
        : null,
    },
    sent: sendError ? `FAILED: ${sendError.message}` : "delivered",
    typeRadarEnabled: process.env.TYPE_RADAR_ENABLED === "true",
  }, null, 2));

  if (sendError) {
    console.log(
      "\n⚠️  Send failed. If it says 'chat not found' / 'bot can't initiate', that account " +
      "hasn't messaged @gennetytestbot yet — open https://t.me/gennetytestbot and press Start, then re-run.",
    );
  } else {
    console.log("\n✅ Invite delivered. Tap the button to open the picker as a user.");
    if (!httpsHost) {
      console.log("   • Only the Skip button is shown (WEBAPP_URL isn't https — no tunnel).");
    } else if (process.env.TYPE_RADAR_ENABLED !== "true") {
      console.log("   • The picker will fail to load the deck until you set TYPE_RADAR_ENABLED=true");
      console.log("     in .env.local and restart `pnpm dev:bot` (routes 404 while the flag is off).");
    } else if ((user?.age ?? 99) > 28 || !user?.preference) {
      console.log("   • Deck needs age ≤ 28 (band A) + a gender preference on this account, else it 409s.");
    }
    console.log("   • Make sure `pnpm dev:webapp` is running behind the ngrok tunnel in WEBAPP_URL.");
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("TYPE-RADAR-DEMO FAILED:", err.message);
  process.exit(1);
});
