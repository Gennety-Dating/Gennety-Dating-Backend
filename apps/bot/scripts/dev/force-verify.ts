/**
 * Dev-only: complete identity verification for a test account WITHOUT the live
 * Persona liveness capture, while still running the REAL post-verify pipeline
 * work — the AI-vision Elo seed and (when enabled) Type Radar appearance tagging
 * — so the account lands with a real `eloScore` / `eloSeedDetails` and, for
 * matching, a `verified` status. Persona's selfie↔photo CompareFaces is the only
 * step skipped; `photoFaceScores` are written as synthetic passing values so the
 * `photos[i] ↔ photoFaceScores[i]` invariant holds.
 *
 * Use during E2E when the Persona sandbox capture is tedious and you just need a
 * match-eligible second account. NOT a production path — with
 * MANDATORY_VERIFICATION_ENABLED on, real activation happens ONLY through the
 * pipeline's `verified` outcome; this is a local dev shortcut guarded to the dev
 * DB + a non-empty bypass list.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/force-verify.ts --tg=5986970093
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/force-verify.ts --tg=5986970093 --apply
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

if (
  process.env.BOT_USERNAME !== "gennetytestbot" ||
  !process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev")
) {
  throw new Error(
    "Refusing to run: expected BOT_USERNAME=gennetytestbot and the local localhost:5434/gennety_dev database.",
  );
}
if (!(process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "").trim()) {
  throw new Error(
    "Refusing to run: DEV_OTP_BYPASS_TELEGRAM_IDS must be non-empty (dev-only guard).",
  );
}

const apply = process.argv.includes("--apply");
// --seed-only: run just the vision Elo seed + appearance tagging (no
// verification-state write). For an already-verified account whose Elo seed
// failed (e.g. the GPT-5.6 temperature 400) — re-seeds without disturbing a
// real Persona verification.
const seedOnly = process.argv.includes("--seed-only");
const tgArg = process.argv.find((a) => a.startsWith("--tg="));
const tgId = BigInt(tgArg ? tgArg.slice("--tg=".length) : "5986970093");

const { prisma } = await import("@gennety/db");
const { Bot } = await import("grammy");
const { env } = await import("../../src/config.js");
const { seedEloFromVisionDefault } = await import("../../src/services/elo-seed.js");
const { tagAndPersistAppearanceDefault } = await import(
  "../../src/services/appearance-tags.js"
);

const user = await prisma.user.findUnique({
  where: { telegramId: tgId },
  include: { profile: true },
});
if (!user || !user.profile) {
  console.error(`No user/profile for tg=${tgId}.`);
  process.exit(1);
}
const photos = user.profile.photos ?? [];
console.log(
  `target tg=${tgId} id=${user.id} status=${user.status} step=${user.onboardingStep} verif=${user.verificationStatus} photos=${photos.length}`,
);
if (photos.length === 0) {
  console.error("Refusing: user has no profile photos to verify.");
  process.exit(1);
}
if (!["onboarding", "paused", "active"].includes(user.status)) {
  console.error(
    `Refusing: status='${user.status}' is moderation-owned; will not force-verify.`,
  );
  process.exit(1);
}

if (!apply) {
  console.log(
    seedOnly
      ? "\nDry-run (--seed-only). Re-run with --apply to run just the real Elo vision seed + appearance tagging (verification state untouched)."
      : "\nDry-run. Re-run with --apply to: run the real Elo vision seed + appearance tagging, then set verified/active (skips only Persona CompareFaces).",
  );
  await prisma.$disconnect();
  process.exit(0);
}

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN missing.");
const api = new Bot(token).api;

// 1) Real AI-vision Elo seed — the temperature:0 call the pipeline runs on a
//    `verified` outcome. Writes eloScore / eloSeededAt / eloSeedDetails.
const seed = await seedEloFromVisionDefault(user.id, photos, api);
console.log("elo seed:", JSON.stringify(seed));

// 2) Type Radar candidate tagging (its own vision pass), when enabled.
if (env.TYPE_RADAR_ENABLED) {
  try {
    await tagAndPersistAppearanceDefault(user.id, photos, user.gender, api);
    console.log("appearance tagging: done");
  } catch (err) {
    console.warn("appearance tagging failed (non-fatal):", err);
  }
}

// 3) Verification state — skip Persona/Rekognition, synthesize passing scores.
//    Skipped entirely under --seed-only (leave a real verification intact).
if (seedOnly) {
  console.log(
    `\n✅ re-seeded tg=${tgId} (verification state untouched).`,
  );
} else {
  const now = new Date();
  const faceScores = photos.map(() => 0.95);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationStatus: "verified",
      ...(user.status === "onboarding" || user.status === "paused"
        ? { status: "active" }
        : {}),
      verifiedAt: now,
      faceMatchedAt: now,
      faceMatchScore: 0.95,
      personaInquiryId: `dev-skip-${tgId}-${now.getTime()}`,
      profile: { update: { photoFaceScores: faceScores } },
    },
  });
  console.log(
    `\n✅ force-verified tg=${tgId} → verified/active; photoFaceScores=[${faceScores.join(", ")}]`,
  );
}
await prisma.$disconnect();
