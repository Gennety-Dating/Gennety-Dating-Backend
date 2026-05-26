/**
 * Inspect a single user's onboarding state in depth — messageHistory length,
 * profile fields populated, photo count, verification state. Used during
 * E2E testing to confirm each phase actually advanced server-side.
 *
 * Usage: pnpm --filter @gennety/bot exec tsx scripts/dev/inspect-user.ts <tgId>
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const arg = process.argv[2];
if (!arg) {
  console.error("usage: inspect-user.ts <telegramId>");
  process.exit(1);
}

const tgId = BigInt(arg);
const { prisma } = await import("@gennety/db");

const user = await prisma.user.findUnique({
  where: { telegramId: tgId },
  include: { profile: true },
});

if (!user) {
  console.log(`no user with tg=${tgId}`);
  process.exit(0);
}

console.log("user:");
console.log(`  id=${user.id}`);
console.log(`  tg=${user.telegramId}`);
console.log(`  email=${user.email}`);
console.log(`  firstName=${user.firstName ?? "<null>"}`);
console.log(`  age=${user.age ?? "<null>"}`);
console.log(`  gender=${user.gender ?? "<null>"}`);
console.log(`  preference=${user.preference ?? "<null>"}`);
console.log(`  language=${user.language}`);
console.log(`  onboardingStep=${user.onboardingStep}`);
console.log(`  status=${user.status}`);
console.log(`  verificationStatus=${user.verificationStatus}`);
console.log(`  isEmailVerified=${user.isEmailVerified}`);
console.log(`  termsAccepted=${user.termsAccepted}`);
console.log(`  consentedAt=${user.consentedAt?.toISOString() ?? "<null>"}`);
console.log(`  verificationSkippedAt=${user.verificationSkippedAt?.toISOString() ?? "<null>"}`);
console.log(`  verifiedAt=${user.verifiedAt?.toISOString() ?? "<null>"}`);
console.log(`  personaInquiryId=${user.personaInquiryId ?? "<null>"}`);
console.log(`  statusMessageId=${user.statusMessageId ?? "<null>"}`);
console.log(`  lastMessageAt=${user.lastMessageAt?.toISOString() ?? "<null>"}`);

const msgHistory = Array.isArray(user.messageHistory) ? user.messageHistory : [];
console.log(`  messageHistory.length=${msgHistory.length}`);
if (msgHistory.length > 0) {
  const last = msgHistory[msgHistory.length - 1] as Record<string, unknown>;
  console.log(`    last role=${last.role}, contentPreview="${String(last.content ?? "").slice(0, 120)}"`);
}

console.log("");
console.log("profile:");
if (!user.profile) {
  console.log("  <no profile row yet>");
} else {
  const p = user.profile;
  console.log(`  eloScore=${p.eloScore}`);
  console.log(`  eloMatchesPlayed=${p.eloMatchesPlayed}`);
  console.log(`  height=${p.height ?? "<null>"}`);
  console.log(`  ethnicity=${p.ethnicity ?? "<null>"}`);
  console.log(`  hobbies=[${p.hobbies.join(", ")}]`);
  console.log(`  partnerPreferences="${(p.partnerPreferences ?? "").slice(0, 80)}"`);
  console.log(`  psychologicalSummary.length=${(p.psychologicalSummary ?? "").length}`);
  console.log(`  negativeConstraints.length=${(p.negativeConstraints ?? "").length}`);
  console.log(`  photos=${p.photos.length}`);
  console.log(`  profileMedia=${(p.profileMedia as unknown[]).length ?? 0}`);
  console.log(`  photoFaceScores=[${p.photoFaceScores.join(", ")}]`);
  console.log(`  embeddingDirty=${p.embeddingDirty}`);
  console.log(`  standbyCount=${p.standbyCount}`);
}

await prisma.$disconnect();
