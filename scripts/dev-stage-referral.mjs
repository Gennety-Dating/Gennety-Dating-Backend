#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot only) — stage the referral program
 * ("Give a date, get a date") so every screen can be reviewed by hand.
 *
 * It:
 *   - upserts your account as a verified/active REFERRER with a seeded
 *     `referralVerifiedCount` (default 2 → the ladder shows rung 1 done, next 3);
 *   - upserts a second account as an INVITEE attributed to you
 *     (`referralSource = referral:<yourId>`, gift unclaimed);
 *   - DMs the referrer the ladder Mini App (dark + light) and prints the signed
 *     share-card URL;
 *   - DMs the invitee the onboarding welcome-gift screen
 *     (`onboarding.html?preview=referral-gift`, dark + light);
 *   - with `--fire-reward`, runs the REAL settle for the invitee so you get the
 *     genuine "reward credited" DM (with the gift effect) and the ladder ticks up.
 *
 * Requires `REFERRAL_FEATURE_ENABLED=true` + the referral columns pushed
 * (`pnpm dev:db:push`) + the dev bot/webapp running with a real HTTPS tunnel.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-referral.mjs --apply
 * Optional:
 *   --referrer-tg=782065541 --invitee-tg=5986970093 --count=2 --lang=ru
 *   --fire-reward   also settle the invitee → real reward DM to the referrer
 *   --force         bypass the gennetytestbot / local-DB guards
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";

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
const apply = argv.get("apply") === "true";
const force = argv.get("force") === "true";
const fireReward = argv.get("fire-reward") === "true";
const referrerTg = BigInt(argv.get("referrer-tg") ?? "782065541");
const inviteeTg = BigInt(argv.get("invitee-tg") ?? "5986970093");
const count = Number(argv.get("count") ?? "2");
const lang = argv.get("lang") ?? "en";

const token = process.env.BOT_TOKEN;
const webapp = (process.env.WEBAPP_URL || "").replace(/\/$/, "");
const publicBase = (process.env.PUBLIC_BASE_URL || "https://dating-api.gennety.com").replace(/\/$/, "");

async function tgSend(chatId, text, options = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // chat_id may arrive as a BigInt (telegramId) — coerce so JSON.stringify
    // doesn't throw. Telegram chat ids fit safely in a JS number.
    body: JSON.stringify({ chat_id: Number(chatId), text, ...options }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`Telegram sendMessage failed: ${json?.description ?? res.status}`);
  return json.result;
}

async function tgSendPhoto(chatId, photoUrl, caption, options = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), photo: photoUrl, caption, ...options }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`Telegram sendPhoto failed: ${json?.description ?? res.status}`);
  return json.result;
}

/** Two-theme web_app buttons for a Mini App path (mirrors dev-open-miniapp). */
function miniAppButtons(path) {
  const sep = path.includes("?") ? "&" : "?";
  return {
    inline_keyboard: [
      [{ text: "🌚 Тёмная", web_app: { url: `${webapp}/${path}${sep}theme=dark&lang=${lang}` } }],
      [{ text: "🌝 Светлая", web_app: { url: `${webapp}/${path}${sep}theme=light&lang=${lang}` } }],
    ],
  };
}

/** Same HMAC as public/routes/referral.ts cardSig — for the printable card URL. */
function cardSig(referrerId) {
  return createHmac("sha256", token).update(`referral-card:${referrerId}`).digest("hex").slice(0, 24);
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(`Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force to override.`);
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing: DATABASE_URL is not the local localhost:5434/gennety_dev DB. Use --force to override.");
  }
  if (!token) throw new Error("Missing BOT_TOKEN in local env.");
  if (!webapp.startsWith("https://")) {
    console.warn(`⚠️  WEBAPP_URL is "${webapp || "(empty)"}" — the Mini App buttons need a real HTTPS tunnel to open.`);
  }
  if (process.env.REFERRAL_FEATURE_ENABLED !== "true") {
    console.warn("⚠️  REFERRAL_FEATURE_ENABLED is not 'true' — the menu row / routes will 404. Set it in .env.local and restart the bot.");
  }

  const { prisma } = await import("@gennety/db");
  const { t } = await import("@gennety/shared");
  const CITY = { homeCityKey: "kyiv", homeCountryCode: "UA", latitude: 50.4501, longitude: 30.5234, timeZone: "Europe/Kyiv" };
  const DOMAIN = "kneu.edu.ua";
  const now = new Date();

  // ── Referrer: verified + active, ladder seeded to `count` ──────────────
  const referrerData = {
    firstName: "Anna", gender: "female", preference: "men", age: 25,
    language: lang, status: "active", onboardingStep: "completed",
    email: `dev+${referrerTg}@${DOMAIN}`, universityDomain: DOMAIN, isEmailVerified: true,
    verificationStatus: "verified", verifiedAt: now, themeChosenAt: now,
    hasConsented: true, consentedAt: now, termsAccepted: true, termsAcceptedAt: now,
    referralVerifiedCount: count, lastMessageAt: now,
  };

  // ── Invitee: attributed to the referrer, gift unclaimed, mid-onboarding ─
  // Pre-visual gates satisfied so onboarding routing reaches the gift screen
  // (the ?preview=referral-gift button jumps straight there anyway).
  const inviteeData = {
    firstName: "Max", gender: "male", preference: "women", age: 27,
    language: lang, status: "onboarding", onboardingStep: "conversational",
    email: `dev+${inviteeTg}@${DOMAIN}`, universityDomain: DOMAIN, isEmailVerified: true,
    aiMemoryExportPreference: "undecided", themeChosenAt: now,
    hasConsented: true, consentedAt: now, termsAccepted: true, termsAcceptedAt: now,
    referralInviteePremiumAt: null, referralCountedAt: null,
    lastMessageAt: now,
  };

  if (!apply) {
    console.log(`[dry-run] would upsert REFERRER tg=${referrerTg} (referralVerifiedCount=${count}) + INVITEE tg=${inviteeTg} (referralSource=referral:<referrerId>)`);
    console.log("[dry-run] re-run with --apply");
    await prisma.$disconnect();
    return;
  }

  const referrer = await prisma.user.upsert({
    where: { telegramId: referrerTg }, update: referrerData, create: { telegramId: referrerTg, ...referrerData },
    select: { id: true, firstName: true },
  });
  await prisma.profile.upsert({
    where: { userId: referrer.id }, update: { ...CITY }, create: { userId: referrer.id, ...CITY, photos: [] },
  });

  const invitee = await prisma.user.upsert({
    where: { telegramId: inviteeTg },
    update: { ...inviteeData, referralSource: `referral:${referrer.id}` },
    create: { telegramId: inviteeTg, ...inviteeData, referralSource: `referral:${referrer.id}` },
    select: { id: true },
  });
  await prisma.profile.upsert({
    where: { userId: invitee.id }, update: { ...CITY }, create: { userId: invitee.id, ...CITY, photos: [] },
  });

  console.log(`✔ referrer ${referrer.firstName} tg=${referrerTg} id=${referrer.id} (referralVerifiedCount=${count})`);
  console.log(`✔ invitee  tg=${inviteeTg} id=${invitee.id} (referralSource=referral:${referrer.id})`);

  // Every user-facing referral surface, sent to the right side with a header
  // line so each can be reviewed in context.
  const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=referral_${referrer.id}`;
  const cardUrl = `${publicBase}/v1/referral/card?u=${referrer.id}&sig=${cardSig(referrer.id)}`;
  const joinKb = { inline_keyboard: [[{ text: t(lang, "referralShareJoin"), url: inviteLink }]] };

  // ══ REFERRER SIDE (tg=782065541) ══════════════════════════════════════
  // A. Menu hub — the "Пригласить друга" entry (message + share button).
  await tgSend(referrerTg, "──────────\nA. РЕФЕРОВОД · меню-хаб (по кнопке «Пригласить друга»):");
  await tgSend(referrerTg, `${t(lang, "referralHubTitle")}\n\n${t(lang, "referralHubTagline")}`, {
    reply_markup: {
      inline_keyboard: [[{ text: t(lang, "referralShareButton"), web_app: { url: `${webapp}/referral.html?theme=dark&lang=${lang}` } }]],
    },
  });
  // B. Ladder Mini App (both themes).
  await tgSend(referrerTg, "──────────\nB. РЕФЕРОВОД · экран лестницы наград (обе темы):", {
    reply_markup: miniAppButtons("referral.html"),
  });
  // C. The forwarded invite — exactly what the referrer sends (card + caption + Join).
  await tgSend(referrerTg, "──────────\nC. РЕФЕРОВОД · что уходит другу при пересылке (карточка + подпись + кнопка):");
  await tgSendPhoto(referrerTg, cardUrl, t(lang, "referralShareCaption"), { reply_markup: joinKb });

  // ══ INVITEE SIDE (tg=5986970093) ══════════════════════════════════════
  // C(recv). What the invited friend receives.
  await tgSend(inviteeTg, "──────────\nD. ПРИГЛАШЁННЫЙ · сообщение-приглашение, которое он получает:");
  await tgSendPhoto(inviteeTg, cardUrl, t(lang, "referralShareCaption"), { reply_markup: joinKb });
  // D. Onboarding welcome-gift screen (both themes).
  await tgSend(inviteeTg, "──────────\nE. ПРИГЛАШЁННЫЙ · экран подарка Premium в онбординге (обе темы):", {
    reply_markup: miniAppButtons("onboarding.html?preview=referral-gift"),
  });
  console.log(`\nShare-card PNG URL:\n  ${cardUrl}`);

  // ── Optionally fire the REAL reward settle → genuine DM to the referrer ─
  if (fireReward) {
    await tgSend(referrerTg, "──────────\nF. РЕФЕРОВОД · DM-награда (когда приглашённый прошёл верификацию):");
    const api = {
      async sendMessage(chatId, text, options = {}) {
        return tgSend(chatId, text, options);
      },
    };
    const { settleReferralOnVerified } = await import("../apps/bot/src/services/referral-notify.js");
    await settleReferralOnVerified(invitee.id, api);
    const after = await prisma.user.findUnique({ where: { id: referrer.id }, select: { referralVerifiedCount: true } });
    console.log(`\n🎉 fired reward settle for the invitee → referrer DM sent; referralVerifiedCount now ${after?.referralVerifiedCount}.`);
  }

  console.log("\n=== STAGED ===");
  console.log(`Referrer tg=${referrerTg} · Invitee tg=${inviteeTg} · lang=${lang}`);
  console.log("Open the DMed buttons in @gennetytestbot to review every screen.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
