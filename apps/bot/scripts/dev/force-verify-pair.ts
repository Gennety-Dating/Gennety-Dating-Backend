/**
 * ONE-OFF, dev-only: unblock the E2E-test pair without running the real
 * Face Liveness check. Fixes A's gender/preference (both accounts came out
 * of onboarding as female/men, which the match engine can never pair — see
 * mutual-gender-compatibility filter §3.2 filter 3), then writes the SAME
 * terminal fields the real verification pipeline writes on a `verified`
 * quorum outcome (services/verification-pipeline.ts persistOutcome,
 * shouldActivate branch) — verificationStatus, verifiedAt, status: active,
 * faceMatchScore, faceMatchedAt, personaInquiryId (fake dev session id),
 * photoFaceScores (1:1 with photos, all passing). Elo is deliberately left
 * at its 500 default (no real vision seed) and verifiedSelfiePath is left
 * null (no real reference selfie) — a later photo edit will ask for one
 * real liveness check on rerun, which is fine for this test's purpose.
 *
 * Refuses to run unless DATABASE_URL points at the dev DB and
 * DEV_OTP_BYPASS_TELEGRAM_IDS is non-empty — same double-guard as the other
 * dev/ scripts.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/force-verify-pair.ts
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/force-verify-pair.ts --apply
 * Without --apply it's a dry run.
 */
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const url = process.env.DATABASE_URL ?? "";
const isDevDb = url.includes("5434") && url.includes("gennety_dev");
if (!isDevDb) {
  console.error(
    `[force-verify-pair] refusing: DATABASE_URL is not the dev DB (need localhost:5434/gennety_dev).\n  got: ${url.replace(/:[^:@/]+@/, ":***@")}`,
  );
  process.exit(1);
}
if (!process.env.DEV_OTP_BYPASS_TELEGRAM_IDS) {
  console.error("[force-verify-pair] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS empty (not a dev env)");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

// A = 782065541 (student track, meant to be male seeking women per the E2E
// test plan). B = 5986970093 (general track, female seeking men) is already
// correct and untouched on gender.
const A_TG = 782065541n;
const B_TG = 5986970093n;

const { prisma } = await import("@gennety/db");

const [a, b] = await Promise.all([
  prisma.user.findUnique({ where: { telegramId: A_TG }, include: { profile: true } }),
  prisma.user.findUnique({ where: { telegramId: B_TG }, include: { profile: true } }),
]);

if (!a || !b) {
  console.error(`[force-verify-pair] missing user(s): a=${!!a} b=${!!b}`);
  process.exit(1);
}

console.log("before:");
for (const u of [a, b]) {
  console.log(
    `  tg=${u.telegramId} gender=${u.gender} preference=${u.preference} status=${u.status} verificationStatus=${u.verificationStatus} photos=${u.profile?.photos.length ?? 0}`,
  );
}

if (!apply) {
  console.log("\n(dry run — pass --apply to write)");
  process.exit(0);
}

await prisma.$transaction(async (tx) => {
  // 1. Fix A's gender so the pair is mutually compatible.
  await tx.user.update({
    where: { id: a.id },
    data: { gender: "male", preference: "women" },
  });

  // 2. Force-verify both, mirroring persistOutcome's shouldActivate branch.
  for (const u of [a, b]) {
    const photoCount = u.profile?.photos.length ?? 0;
    const now = new Date();
    await tx.user.update({
      where: { id: u.id },
      data: {
        verificationStatus: "verified",
        verifiedAt: now,
        status: "active",
        faceMatchScore: 1,
        faceMatchedAt: now,
        personaInquiryId: `dev-force-verify-${randomUUID()}`,
      },
    });
    await tx.profile.update({
      where: { userId: u.id },
      data: {
        photoFaceScores: Array(photoCount).fill(1),
      },
    });
  }
});

const [a2, b2] = await Promise.all([
  prisma.user.findUnique({ where: { telegramId: A_TG }, include: { profile: true } }),
  prisma.user.findUnique({ where: { telegramId: B_TG }, include: { profile: true } }),
]);

console.log("\nafter:");
for (const u of [a2, b2]) {
  if (!u) continue;
  console.log(
    `  tg=${u.telegramId} gender=${u.gender} preference=${u.preference} status=${u.status} verificationStatus=${u.verificationStatus} photoFaceScores=${JSON.stringify(u.profile?.photoFaceScores)}`,
  );
}

process.exit(0);
