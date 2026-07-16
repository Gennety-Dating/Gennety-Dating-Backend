#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot + localhost dev DB only).
 *
 * Fast-forwards two existing Telegram test accounts to the MINIMAL "ready to
 * match" state the Calendar Mini App needs — WITHOUT walking full onboarding —
 * so `dev-trigger-scheduling.mjs` can drop them straight onto the calendar.
 *
 * It only fills the fields `assertReady` (in dev-trigger-scheduling) checks:
 *   status=active, onboardingStep=completed, isEmailVerified + universityDomain,
 *   gender + preference, and a Profile with homeCityKey + coords (+ timeZone).
 * Existing values are preserved; only missing/blocking ones are set. It does
 * NOT touch messageHistory, photos, embeddings, or verification artifacts.
 *
 * Usage:
 *   node scripts/dev-prep-calendar-accounts.mjs --a=<telegramId> --b=<telegramId>
 *
 * Both accounts must have opened a chat with @gennetytestbot at least once,
 * otherwise the later "send Calendar button" step can't DM them.
 *
 * Safe to run while `pnpm dev:bot` is up — this only writes to the dev DB.
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
const aTg = BigInt(args.get("a") ?? "782065541");
const bTg = BigInt(args.get("b") ?? "5986970093");

// Both accounts share this city so the same-city match gate passes. Kyiv centre.
const CITY = {
  homeCityKey: "ua:kyiv",
  homeCity: "Kyiv",
  homeCountryCode: "UA",
  latitude: 50.4501,
  longitude: 30.5234,
  timeZone: "Europe/Kyiv",
};

async function prep(prisma, telegramId, fallbackGender) {
  const u = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true, firstName: true, gender: true, preference: true,
      isEmailVerified: true, universityDomain: true, language: true,
      profile: { select: { id: true, homeCityKey: true, latitude: true, longitude: true } },
    },
  });
  if (!u) {
    throw new Error(
      `Telegram ${telegramId} has no user row — open @gennetytestbot from that ` +
      `account and send /start once, then re-run.`,
    );
  }

  await prisma.user.update({
    where: { id: u.id },
    data: {
      status: "active",
      onboardingStep: "completed",
      isEmailVerified: true,
      universityDomain: u.universityDomain ?? "stanford.edu",
      gender: u.gender ?? fallbackGender,
      preference: u.preference ?? "both",
      language: u.language ?? "en",
      firstName: u.firstName ?? (fallbackGender === "female" ? "Test A" : "Test B"),
    },
  });

  await prisma.profile.upsert({
    where: { userId: u.id },
    create: {
      userId: u.id,
      ...CITY,
      height: 175,
      hobbies: [],
      partnerPreferences: "open to meeting someone new",
    },
    update: { ...CITY },
  });

  return { id: u.id, tg: telegramId.toString(), name: u.firstName };
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Pass --force to override.");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
  }

  const { prisma } = await import("@gennety/db");
  const a = await prep(prisma, aTg, "female");
  const b = await prep(prisma, bTg, "male");
  console.log("Prepared for calendar test:");
  console.log(JSON.stringify({ A: a, B: b }, null, 2));
  console.log("\nNext: node scripts/dev-trigger-scheduling.mjs --primary-tg=" + a.tg + " --secondary-tg=" + b.tg);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
