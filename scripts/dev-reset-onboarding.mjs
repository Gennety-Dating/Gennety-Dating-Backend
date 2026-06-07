#!/usr/bin/env node
/**
 * Dev-only: reset the two local Telegram test accounts back to a clean
 * onboarding state so the whole flow can be walked manually from /start.
 *
 *   - users row: status=onboarding, onboardingStep=consent, all gating /
 *     profile-basics / verification / email fields cleared, messageHistory
 *     wiped, re-engagement reset. Telegram link (telegramId) is preserved.
 *   - profiles row deleted (the onboarding agent re-creates it).
 *   - every match involving either account deleted (clears stale
 *     negotiating_venue rows that would confuse the venue handler).
 *   - bot_sessions row deleted (so stale `onboardingStep=completed` session
 *     state doesn't shadow the DB on first /start).
 *
 * Usage:
 *   pnpm dev:reset-onboarding        # dry-run
 *   pnpm dev:reset-onboarding:apply  # write
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function loadEnv(p, ov) {
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const e = t.indexOf("=");
    if (e === -1) continue;
    const k = t.slice(0, e).trim();
    let v = t.slice(e + 1).trim().replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (ov || process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv(resolve(root, ".env.local"), true);
loadEnv(resolve(root, ".env"), false);

const apply = process.argv.includes("--apply");
const IDS = [782065541n, 5986970093n];

if (
  process.env.BOT_USERNAME !== "gennetytestbot" ||
  !process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev")
) {
  throw new Error(
    "Refusing to run: expected BOT_USERNAME=gennetytestbot and the local localhost:5434/gennety_dev database.",
  );
}

const { prisma } = await import("@gennety/db");

const users = await prisma.user.findMany({
  where: { telegramId: { in: IDS } },
  select: { id: true, telegramId: true, firstName: true, status: true, onboardingStep: true },
});
console.log("Found:", users.map((u) => ({ tg: u.telegramId.toString(), name: u.firstName, status: u.status, step: u.onboardingStep })));

if (!apply) {
  console.log("\nDry-run. Re-run with --apply to reset these accounts.");
  await prisma.$disconnect();
  process.exit(0);
}

const userIds = users.map((u) => u.id);

// 1. Delete matches involving either account (cascades score logs / events / reports).
const delMatches = await prisma.match.deleteMany({
  where: { OR: [{ userAId: { in: userIds } }, { userBId: { in: userIds } }] },
});
console.log(`Deleted ${delMatches.count} match(es).`);

// 2. Delete profiles (re-created by the onboarding agent).
const delProfiles = await prisma.profile.deleteMany({ where: { userId: { in: userIds } } });
console.log(`Deleted ${delProfiles.count} profile(s).`);

// 3. Reset the user rows to a clean consent-step state.
for (const u of users) {
  await prisma.user.update({
    where: { id: u.id },
    data: {
      status: "onboarding",
      onboardingStep: "consent",
      aiMemoryExportPreference: "undecided",
      aiMemoryExportPreferenceAt: null,
      hasConsented: false,
      consentedAt: null,
      termsAccepted: false,
      termsAcceptedAt: null,
      researchOptIn: false,
      language: null,
      email: null,
      universityDomain: null,
      isEmailVerified: false,
      emailOtp: null,
      emailOtpExpiresAt: null,
      firstName: null,
      surname: null,
      age: null,
      gender: null,
      preference: null,
      major: null,
      messageHistory: [],
      lastMessageAt: null,
      lastPreMatchAnnounceAt: null,
      reEngagementStep: 0,
      reEngagementNextAt: null,
      statusMessageId: null,
      verificationStatus: "unverified",
      personaInquiryId: null,
      verifiedAt: null,
      verificationSkippedAt: null,
      verifiedSelfiePath: null,
      faceMatchScore: null,
      faceMatchedAt: null,
      selfiePath: null,
    },
  });
  console.log(`Reset user tg=${u.telegramId.toString()} → onboarding/consent.`);
}

// 4. Drop bot_sessions (grammY key == chat id == telegramId for private chats).
try {
  const keys = IDS.map((id) => id.toString());
  const delSessions = await prisma.botSession.deleteMany({ where: { key: { in: keys } } });
  console.log(`Deleted ${delSessions.count} bot_session(s).`);
} catch (err) {
  console.warn("bot_sessions cleanup skipped:", err instanceof Error ? err.message : err);
}

// 5. Clear any leftover mobile-side email OTPs for the addresses we'll reuse.
try {
  await prisma.emailOtp.deleteMany({ where: { email: { endsWith: "@ukma.edu.ua" } } });
} catch { /* table optional */ }

console.log("\nReset complete. Both accounts can now /start a fresh onboarding.");
await prisma.$disconnect();
