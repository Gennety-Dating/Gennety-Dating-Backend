#!/usr/bin/env node
/**
 * Dev-only helper (local DEP bot only).
 *
 * Seeds a male + female synthetic profile and drops them straight onto the
 * Date-Ticket gate (post mutual-accept), so you can manually walk the premium
 * ticket flow in Telegram:
 *   - both accounts receive the real 🎟️ ticket-offer DM (Mini App button)
 *   - the MALE opens it and can "Оплатить за нас обоих" (buy + gift her ticket)
 *   - the FEMALE sees the "уже оплатил твой билет ❤️" surprise card + DM
 *
 * Mirrors the real mutual-accept transition in decision.ts (male = side A) and
 * fires the genuine sendTicketOffer(), so every message is production copy.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-ticket-gift.mjs --apply
 * Optional:
 *   --man-tg=782065541 --woman-tg=5986970093 --lang=ru
 *   --force   bypass the gennetytestbot / local-DB guards
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
const lang = argv.get("lang") ?? "ru";

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(`Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force to override.`);
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing: DATABASE_URL is not the local localhost:5434/gennety_dev DB. Use --force to override.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  const { prisma } = await import("@gennety/db");
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { sendTicketOffer } = await import("../apps/bot/src/handlers/matching/ticket-gate.js");

  // Minimal Bot-API shim (only sendMessage is exercised by sendTicketOffer).
  const api = {
    async sendMessage(chatId, text, options = {}) {
      const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, ...options }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(`Telegram sendMessage failed: ${json?.description ?? res.status}`);
      return json.result;
    },
  };

  const CITY = { homeCityKey: "kyiv", homeCountryCode: "UA", latitude: 50.4501, longitude: 30.5234, timeZone: "Europe/Kyiv" };
  const DOMAIN = "kneu.edu.ua";
  const now = new Date();

  const people = [
    { tg: manTg, role: "MAN (buyer)", firstName: "Артём", gender: "male", preference: "women", age: 28,
      summary: "Заботливый, берёт инициативу на себя. Любит уютные кофейни и долгие разговоры." },
    { tg: womanTg, role: "WOMAN (recipient)", firstName: "Марина", gender: "female", preference: "men", age: 26,
      summary: "Тёплая, ценит внимание и жесты. Обожает книги и вечерний Киев." },
  ];

  const ids = {};
  for (const p of people) {
    const data = {
      firstName: p.firstName, gender: p.gender, preference: p.preference, age: p.age,
      language: lang, status: "active", onboardingStep: "completed",
      email: `dev+${p.tg}@${DOMAIN}`, universityDomain: DOMAIN, isEmailVerified: true,
      verificationStatus: "verified", verifiedAt: now,
      hasConsented: true, consentedAt: now, termsAccepted: true, termsAcceptedAt: now,
      lastMessageAt: now,
    };
    if (!apply) { console.log(`[dry-run] would upsert ${p.role} tg=${p.tg}`); continue; }
    const user = await prisma.user.upsert({
      where: { telegramId: p.tg },
      update: data,
      create: { telegramId: p.tg, ...data },
      select: { id: true, telegramId: true, firstName: true, gender: true },
    });
    ids[p.role] = user.id;
    await prisma.profile.upsert({
      where: { userId: user.id },
      update: { ...CITY, psychologicalSummary: p.summary },
      create: { userId: user.id, ...CITY, psychologicalSummary: p.summary, photos: [] },
    });
    console.log(`✔ seeded ${p.role}: ${user.firstName} (${user.gender}) tg=${user.telegramId} id=${user.id}`);
  }

  if (!apply) { console.log("\n[dry-run] no match created. Re-run with --apply."); await prisma.$disconnect(); return; }

  const manId = ids["MAN (buyer)"];
  const womanId = ids["WOMAN (recipient)"];

  // Clear any prior in-flight matches involving either account so the gate is clean.
  const cancelled = await prisma.match.updateMany({
    where: {
      status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
      OR: [{ userAId: { in: [manId, womanId] } }, { userBId: { in: [manId, womanId] } }],
    },
    data: { status: "cancelled" },
  });
  if (cancelled.count) console.log(`↺ cancelled ${cancelled.count} prior open match(es).`);

  // Mirror the real mutual-accept transition (decision.ts): man = side A.
  const match = await createProposedMatch(manId, womanId);
  await prisma.match.update({
    where: { id: match.id },
    data: { acceptedByA: true, acceptedByB: true, status: "negotiating" },
  });
  console.log(`✔ match ${match.id} → negotiating (both accepted). Man=A, Woman=B.`);

  // Fire the real ticket offer → DMs both the 🎟️ Mini App button.
  await sendTicketOffer(api, match.id);

  const final = await prisma.match.findUnique({
    where: { id: match.id },
    select: { id: true, status: true, ticketStatus: true, ticketPriceCents: true, ticketExpiresAt: true, userAId: true, userBId: true },
  });
  console.log("\n=== STAGED ===");
  console.log(JSON.stringify({ ...final, ticketExpiresAt: final.ticketExpiresAt?.toISOString() }, null, 2));
  console.log(`\nMatch id: ${match.id}`);
  console.log(`Ticket Mini App URL: ${process.env.WEBAPP_URL}/ticket.html?match=${match.id}&lang=${lang}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
