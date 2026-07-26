#!/usr/bin/env node
/**
 * Dev-only E2E helper.
 *
 * Sends the liveness verification CTA directly to a specific Telegram user,
 * bypassing the conversational onboarding agent. Used when the agent is
 * broken or paused and we still want to test the verification Mini App
 * end-to-end.
 *
 * Mirrors the logic of `sendVerificationCTABare` in
 * `apps/bot/src/handlers/onboarding/verification.ts`:
 *   - looks up user by telegram_id
 *   - flips verificationStatus to "pending"
 *   - sends a message with two inline buttons: "Verify now" (web_app) + "Skip"
 *   - refuses when WEBAPP_URL is not a real HTTPS host (Face Liveness runs in
 *     our own Mini App — there is no hosted fallback to link to)
 *
 * Implemented via raw HTTPS POST to the Telegram Bot API to avoid pulling
 * grammy into this scripts/ resolution context. The PROD code path is
 * structurally identical (keyboard shape + WEBAPP_URL gate); this script
 * exercises the same downstream Mini App.
 *
 * Usage:
 *   pnpm tsx scripts/dev-send-verification-cta.mjs --tg=5986970093
 *
 * Optional:
 *   --lang=ru|en|uk|de|pl     override lang (default = user's DB language)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// .env.local first (wins per the bot's normal load order).
loadEnvFile(resolve(root, ".env.local"));
loadEnvFile(resolve(root, ".env"));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg) => {
    if (!arg.startsWith("--")) return [];
    const eq = arg.indexOf("=");
    if (eq === -1) return [[arg.slice(2), "true"]];
    return [[arg.slice(2, eq), arg.slice(eq + 1)]];
  }),
);

const telegramIdRaw = args.tg ?? args["telegram-id"];
if (!telegramIdRaw) {
  console.error("Missing --tg=<telegram_id>");
  process.exit(1);
}
const telegramId = BigInt(telegramIdRaw);

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  console.error("BOT_TOKEN missing — check .env.local / .env");
  process.exit(1);
}
if (process.env.FACE_LIVENESS_ENABLED !== "true") {
  console.error("FACE_LIVENESS_ENABLED is not 'true' — refusing to send CTA");
  process.exit(2);
}

const { prisma } = await import("@gennety/db");

const user = await prisma.user.findUnique({
  where: { telegramId },
  select: { id: true, language: true, verificationStatus: true },
});
if (!user) {
  console.error(`User with telegram_id=${telegramIdRaw} not found in DB`);
  process.exit(1);
}

const lang = args.lang ?? user.language ?? "en";

// Mark pending — same write sendVerificationCTABare does.
await prisma.user.update({
  where: { id: user.id },
  data: { verificationStatus: "pending" },
});

// Mirror sendVerificationCTABare's WEBAPP_URL gate. Face Liveness runs inside
// our own Mini App, so there is no fallback link — without a real HTTPS host
// (a tunnel in dev) there is genuinely nowhere to send the user.
const webappUrl = process.env.WEBAPP_URL ?? "";
if (!webappUrl.startsWith("https://") || webappUrl.includes("example.invalid")) {
  console.error(
    "WEBAPP_URL is not a real HTTPS host — start a tunnel and point WEBAPP_URL at it",
  );
  process.exit(2);
}

// Append a cache-buster timestamp so Telegram WebView doesn't serve a
// previously-cached version when we've fixed something in dev.
const cacheBust = Date.now().toString(36);
const miniAppUrl = `${webappUrl.replace(/\/+$/, "")}/verification.html?lang=${lang}&v=${cacheBust}`;
const primaryButton = {
  text: btnLabel("verifyBtnGo", lang),
  web_app: { url: miniAppUrl },
};
console.log(`[dev-send-verification-cta] using web_app button: ${miniAppUrl}`);

const replyMarkup = {
  inline_keyboard: [
    [primaryButton],
    [{ text: btnLabel("verifyBtnSkip", lang), callback_data: "verify:skip" }],
  ],
};

const pitchText = pitchTextFor(lang);

const chatId = Number(telegramId);
const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
const res = await fetch(apiUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: pitchText,
    reply_markup: replyMarkup,
  }),
});
const body = await res.json();
if (!res.ok || !body.ok) {
  console.error(
    `[dev-send-verification-cta] Telegram sendMessage failed: ${res.status}`,
    body,
  );
  process.exit(3);
}
console.log(
  `[dev-send-verification-cta] CTA sent (message_id=${body.result?.message_id}). verificationStatus=pending. lang=${lang}.`,
);
await prisma.$disconnect();
process.exit(0);

// ---------- localized copy (mirrors packages/shared/src/i18n.ts) ----------

function btnLabel(key, lang) {
  const dict = {
    en: { verifyBtnGo: "🟢 Verify now", verifyBtnSkip: "⚪️ Skip for now" },
    ru: { verifyBtnGo: "🟢 Пройти верификацию", verifyBtnSkip: "⚪️ Пропустить пока" },
    uk: { verifyBtnGo: "🟢 Пройти верифікацію", verifyBtnSkip: "⚪️ Пропустити поки" },
    de: { verifyBtnGo: "🟢 Jetzt verifizieren", verifyBtnSkip: "⚪️ Erstmal überspringen" },
    pl: { verifyBtnGo: "🟢 Zweryfikuj teraz", verifyBtnSkip: "⚪️ Pomiń na razie" },
  };
  return dict[lang]?.[key] ?? dict.en[key];
}

function pitchTextFor(lang) {
  if (lang === "ru") {
    return (
      "Финальный шаг. Нам нужно убедиться, что вы реальный человек.\n\n" +
      "Селфи, которое мы сделаем во время верификации, мы сравним с каждой фотографией в вашем профиле. " +
      "Фото, на которых не вы, будут отклонены.\n\n" +
      "Отказ от верификации значительно снизит ваш стартовый ELO-рейтинг, " +
      "и алгоритм будет предлагать вам меньше встреч."
    );
  }
  if (lang === "uk") {
    return (
      "Фінальний крок. Нам треба переконатися, що ти реальна людина.\n\n" +
      "Селфі, яке ми зробимо під час верифікації, ми порівняємо з кожним фото у твоєму профілі. " +
      "Фото, на яких не ти, буде відхилено.\n\n" +
      "Відмова від верифікації суттєво знизить твій стартовий ELO-рейтинг, " +
      "і алгоритм пропонуватиме тобі менше зустрічей."
    );
  }
  return (
    "Final step. We need to confirm you're a real person.\n\n" +
    "We compare the selfie captured during verification with every photo in your profile. " +
    "Photos that don't match you will be rejected.\n\n" +
    "Skipping verification will significantly lower your starting ELO rating, " +
    "and the algorithm will surface fewer matches for you."
  );
}
