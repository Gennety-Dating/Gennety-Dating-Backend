#!/usr/bin/env node
/**
 * Dev-only helper (local DEV bot only).
 *
 * Stages the venue-change "wish card" (PRODUCT_SPEC §3.7b / §4.2 — the
 * she-picked-it / ask-him-to-pay moment) and sends the REAL card to the man's
 * Telegram chat, so you can see exactly what he receives when a woman finalises
 * a venue swap with "Предложить ему оплатить".
 *
 * It seeds a scheduled match with `venueChangeStatus = "agreed"`, proposer =
 * the woman, a new agreed venue (+ a venue photo for the duotone hero), then
 * fires the genuine `offerPartnerPay()` — the same function production runs — so
 * the PNG render, caption (`venueWishText`), and the [⭐ Lock it in] /
 * [Not this time] buttons are all real. The card renders in HIS theme/language.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-venue-wish-card.mjs --apply
 * Optional:
 *   --man-tg=782065541 --woman-tg=5986970093 --force
 */
import { existsSync, readFileSync } from "node:fs";
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
const apply = argv.get("apply") === "true";
const force = argv.get("force") === "true";
const manTg = BigInt(argv.get("man-tg") ?? "782065541");
const womanTg = BigInt(argv.get("woman-tg") ?? "5986970093");

// Female portrait → her polaroid on the card. Café interior → duotone hero.
const WOMAN_PORTRAIT = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=640&h=800&fit=crop";
const VENUE_PHOTO = "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=1000&h=690&fit=crop";

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(`Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force to override.`);
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing: DATABASE_URL is not the local localhost:5434/gennety_dev DB. Use --force to override.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  const { prisma } = await import("@gennety/db");
  // Resolve grammy against apps/bot (it's the bot's dep, not the root's) so we
  // build the SAME grammy module instance the handler uses when it constructs
  // its InputFile — one cached module, one class identity.
  const requireFromBot = createRequire(resolve(root, "apps/bot/package.json"));
  const { Bot } = await import(requireFromBot.resolve("grammy"));
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { offerPartnerPay, createVenueInvoiceLink } = await import("../apps/bot/src/handlers/matching/venue-change.js");
  const { renderVenueWishCard } = await import("../apps/bot/src/services/venue-wish-card.js");

  const api = new Bot(process.env.BOT_TOKEN).api;

  const CITY = { homeCityKey: "kyiv", homeCountryCode: "UA", latitude: 50.4501, longitude: 30.5234, timeZone: "Europe/Kyiv" };
  const DOMAIN = "kneu.edu.ua";
  const now = new Date();

  // --- 1. The man (receives the card). Must already exist with photos. ---
  const man = await prisma.user.findUnique({
    where: { telegramId: manTg },
    select: { id: true, firstName: true, gender: true, language: true, theme: true },
  });
  if (!man) throw new Error(`MAN tg=${manTg} not found. Seed him first (e.g. dev-stage-ticket-gift.mjs).`);
  if (man.gender !== "male") throw new Error(`MAN tg=${manTg} has gender=${man.gender}; the wish card is a hetero flow (he pays).`);

  if (!apply) {
    console.log(`[dry-run] MAN = ${man.firstName} (${man.language}/${man.theme}) will receive the card.`);
    console.log(`[dry-run] would upsert WOMAN tg=${womanTg}, stage an agreed venue-change, and call offerPartnerPay().`);
    await prisma.$disconnect();
    return;
  }

  // --- 2. The woman (proposer; her polaroid is on the card). ---
  const wData = {
    firstName: "София", gender: "female", preference: "men", age: 25,
    language: "ru", theme: "dark", status: "active", onboardingStep: "completed",
    email: `dev+${womanTg}@${DOMAIN}`, universityDomain: DOMAIN, isEmailVerified: true,
    verificationStatus: "verified", verifiedAt: now,
    hasConsented: true, consentedAt: now, termsAccepted: true, termsAcceptedAt: now,
    lastMessageAt: now,
  };
  const woman = await prisma.user.upsert({
    where: { telegramId: womanTg },
    update: wData,
    create: { telegramId: womanTg, ...wData },
    select: { id: true, firstName: true },
  });
  const wProfile = await prisma.profile.upsert({
    where: { userId: woman.id },
    update: { ...CITY, psychologicalSummary: "Easy-going and expressive; loves cosy cafés and golden-hour walks." },
    create: { userId: woman.id, ...CITY, psychologicalSummary: "Easy-going and expressive; loves cosy cafés and golden-hour walks.", photos: [] },
    select: { photos: true },
  });

  // Mint her polaroid file_id (upload via the man's chat, then delete) if absent.
  if (!wProfile.photos?.length) {
    const msg = await api.sendPhoto(Number(manTg), WOMAN_PORTRAIT);
    const fileId = msg.photo?.at(-1)?.file_id;
    if (msg.message_id) await api.deleteMessage(Number(manTg), msg.message_id).catch(() => {});
    if (!fileId) throw new Error("Failed to mint the woman's polaroid file_id.");
    await prisma.profile.update({ where: { userId: woman.id }, data: { photos: [fileId] } });
    console.log(`✔ minted woman polaroid file_id=${fileId.slice(0, 16)}…`);
  } else {
    console.log(`✔ woman already has ${wProfile.photos.length} photo(s); reusing.`);
  }

  // --- 3. Clear any prior in-flight match for the pair, then stage a fresh one. ---
  const cancelled = await prisma.match.updateMany({
    where: {
      status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
      OR: [{ userAId: { in: [man.id, woman.id] } }, { userBId: { in: [man.id, woman.id] } }],
    },
    data: { status: "cancelled" },
  });
  if (cancelled.count) console.log(`↺ cancelled ${cancelled.count} prior open match(es).`);

  // Man = side A (so isHeteroPair + payer = the man), woman = side B + proposer.
  const match = await createProposedMatch(man.id, woman.id);

  const agreedTime = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
  agreedTime.setHours(19, 0, 0, 0);
  // Payment deadline: min(agreed + 12h, T − 5h) — matches the lapse rule.
  const expiresAt = new Date(Math.min(now.getTime() + 12 * 3600 * 1000, agreedTime.getTime() - 5 * 3600 * 1000));

  await prisma.match.update({
    where: { id: match.id },
    data: {
      status: "scheduled",
      acceptedByA: true, acceptedByB: true,
      agreedTime,
      // Original (auto-assigned) venue — the eternal default she's moving off of.
      venueName: "Kyiv Food Market",
      venueAddress: "вул. Січових Стрільців, 84, Київ",
      venueLat: 50.4498, venueLng: 30.4959,
      venueGoogleMapsUri: "https://maps.google.com/?q=Kyiv+Food+Market",
      // Agreed venue-change (the cosier place she picked) — the wish card subject.
      venueChangeStatus: "agreed",
      venueChangeProposerId: woman.id,
      venueChangeProposedAt: now,
      venueChangeName: "Kanapa",
      venueChangeAddress: "Андріївський узвіз, 19, Київ",
      venueChangeLat: 50.4593, venueChangeLng: 30.5165,
      venueChangeMapsUri: "https://maps.google.com/?q=Kanapa+Kyiv",
      venueChangePhotoUrl: VENUE_PHOTO,
      venueChangePhotoName: null,
      venueChangeExpiresAt: expiresAt,
      venueChangeExpressAt: null,
      venueChangeOfferPaySentAt: null,
    },
  });
  console.log(`✔ match ${match.id} → scheduled, venueChange=agreed (proposer=София).`);

  // --- 4. Sanity: render the PNG + confirm the Stars invoice link works. ---
  const png = await renderVenueWishCard(api, match.id).catch((e) => { console.warn("render threw:", e); return null; });
  console.log(png ? `✔ wish-card PNG rendered (${png.length} bytes).` : "⚠ PNG render returned null → he'd get the TEXT fallback.");
  try {
    await createVenueInvoiceLink(api, "ru", match.id, "agreed", "Kanapa");
    console.log("✔ Telegram Stars invoice link OK.");
  } catch (e) {
    console.warn("⚠ createInvoiceLink failed — the pay button won't work:", e.message);
  }

  // --- 5. Fire the REAL flow: she offers, he receives the card in his chat. ---
  const res = await offerPartnerPay(api, womanTg, match.id);
  console.log("offerPartnerPay →", JSON.stringify(res));
  if (!res.ok) throw new Error(`offerPartnerPay refused: ${res.reason}`);

  console.log(`\n=== SENT === Wish card delivered to ${man.firstName} (tg=${manTg}).`);
  console.log(`Match id: ${match.id}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
