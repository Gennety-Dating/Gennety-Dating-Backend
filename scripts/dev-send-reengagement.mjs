#!/usr/bin/env node
/**
 * Dev-only helper: preview a re-engagement onboarding nudge.
 *
 * Generates ONE re-engagement message through the REAL worker path
 * (`generateHookMessage` in apps/bot/src/workers/re-engagement.ts, which injects
 * VOICE_CORE and calls OpenAI) and sends it to a Telegram chat via the dev bot,
 * so we can eyeball the brand voice without waiting for the cron/scheduler.
 *
 * It does NOT touch the DB or any user's re-engagement step — it just renders
 * and sends a sample. Context is fully overridable via flags so you can see how
 * the copy adapts to the drop-off step and the touch index.
 *
 * Usage (run from the bot workspace so @gennety resolution + config env work):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-send-reengagement.mjs \
 *     --tg=782065541 --lang=ru --step=conversational --touch=1
 *
 * Flags:
 *   --tg=<id>         target Telegram chat id (required)
 *   --lang=<code>     en|ru|uk|de|pl                       (default: ru)
 *   --step=<key>      consent|language|conversational      (default: conversational)
 *   --touch=<1..5>    which nudge in the decaying chain     (default: 1)
 *   --name=<str>      first name to personalize with        (default: none)
 *   --history=<str>   fake last user line, for context      (default: a hobbies line)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// .env.local first (wins per the bot's normal load order), then .env.
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

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  console.error("BOT_TOKEN missing — check .env.local / .env");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing — check .env.local / .env");
  process.exit(1);
}

const lang = args.lang ?? "ru";
const step = args.step ?? "conversational";
const touch = Number.parseInt(args.touch ?? "1", 10);
const firstName = args.name ?? null;
const lastUserLine =
  args.history ?? "лазаю по горам и много читаю, если честно";

// Import the REAL generator so what you see is exactly what production sends.
const { generateHookMessage } = await import(
  pathToFileURL(
    resolve(root, "apps/bot/src/workers/re-engagement.ts"),
  ).href
);

const messageHistory =
  step === "conversational"
    ? [
        { role: "assistant", content: "расскажи про свои хобби?" },
        { role: "user", content: lastUserLine },
      ]
    : [];

const text = await generateHookMessage(
  {
    onboardingStep: step,
    messageHistory,
    language: lang,
    firstName,
    upcomingStep: touch,
  },
  fetch,
);

console.log("\n─── generated re-engagement message ───");
console.log(`lang=${lang} step=${step} touch=${touch}`);
console.log(text);
console.log("───────────────────────────────────────\n");

const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
const res = await fetch(apiUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: telegramIdRaw,
    text,
    parse_mode: "Markdown",
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(
    `[dev-send-reengagement] Telegram sendMessage failed: ${res.status}\n${body}`,
  );
  process.exit(1);
}

console.log(`[dev-send-reengagement] sent to ${telegramIdRaw} ✅`);
