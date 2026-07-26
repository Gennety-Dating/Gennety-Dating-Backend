#!/usr/bin/env node
/**
 * Dev-only: put a test account back in front of the liveness gate, so the
 * verification flow can be walked again from `/start`.
 *
 * Why this is separate from `dev:reset-onboarding`: that one wipes the account
 * back to the consent screen and deletes the profile. The face-match step needs
 * a finished profile with photos — wiping them means you cannot test the thing
 * you are trying to test. This resets the verification state and nothing else.
 *
 * What it changes:
 *   status              → onboarding    (the gate state: profile done, liveness not)
 *   onboardingStep      → completed
 *   verificationStatus  → unverified
 *   verifiedAt          → null
 *   faceMatchedAt       → null          (clears the pipeline's idempotency marker)
 *   faceMatchScore      → null
 *   personaInquiryId    → null          (drops the spent liveness session id)
 *
 * Deliberately left alone: the profile, its photos, `photoFaceScores`, the Elo
 * seed, and `verifiedSelfiePath`. A fresh pass overwrites the selfie anyway,
 * and keeping it lets you also exercise the rerun path (which reads the stored
 * copy instead of capturing a new one).
 *
 * The previous values are printed first — this is reversible, and on a dev DB
 * that is the whole safety story.
 *
 * Usage:
 *   pnpm dev:reset-verification --tg=782065541
 *   pnpm dev:reset-verification --tg=782065541 --lang=de
 *   pnpm dev:reset-verification --tg=782065541 --expire-selfie
 *
 * `--expire-selfie` additionally clears `verifiedSelfiePath`, which simulates
 * the 90-day GDPR scrub — the state where a photo edit must ask for one more
 * liveness check (PRODUCT_SPEC §1.4).
 *
 * `--lang` switches `User.language`, which is what the liveness detector reads
 * for its on-screen instructions. Settings is unreachable from inside the
 * verification gate, so without this there is no way to eyeball the check in
 * another language.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Hand-rolled rather than `dotenv`: pnpm's strict node_modules does not expose
// it to `scripts/`, and every sibling dev script reads env the same way.
function loadEnv(path, override) {
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

const repoRoot = resolve(import.meta.dirname, "..");
loadEnv(resolve(repoRoot, ".env.local"), true);
loadEnv(resolve(repoRoot, ".env"), false);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? ""] : [a, ""];
  }),
);

const LANGUAGES = ["en", "ru", "uk", "de", "pl"];

if (args.help !== undefined || args.h !== undefined || !args.tg) {
  console.log(
    "usage: pnpm dev:reset-verification --tg=<telegram_id> " +
      `[--lang=${LANGUAGES.join("|")}] [--expire-selfie]`,
  );
  process.exit(args.tg ? 0 : 1);
}

if (args.lang !== undefined && !LANGUAGES.includes(args.lang)) {
  console.error(`✖ --lang must be one of: ${LANGUAGES.join(", ")}`);
  process.exit(1);
}

// Guard: this writes to whatever DATABASE_URL is in scope, and pointing it at
// production would un-verify a real user. `.env.local` is the dev override.
const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl.includes("localhost:5434/gennety_dev")) {
  console.error(
    `✖ DATABASE_URL does not look like a local dev database:\n  ${dbUrl.replace(/:[^:@]*@/, ":***@")}\n` +
      "  Expected the local dev database (localhost:5434/gennety_dev).\n" +
      "  Refusing to reset verification against anything else.",
  );
  process.exit(2);
}

const { prisma } = await import("@gennety/db");

const telegramId = BigInt(args.tg);
const before = await prisma.user.findUnique({
  where: { telegramId },
  select: {
    id: true,
    firstName: true,
    status: true,
    onboardingStep: true,
    language: true,
    verificationStatus: true,
    verifiedAt: true,
    verifiedSelfiePath: true,
    personaInquiryId: true,
    faceMatchedAt: true,
    faceMatchScore: true,
    profile: { select: { photos: true } },
  },
});

if (!before) {
  console.error(`✖ no user with telegram_id=${args.tg} in this database`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log("BEFORE — keep this if you want to restore the account:");
console.log(
  JSON.stringify(
    { ...before, profile: { photos: before.profile?.photos.length ?? 0 } },
    (_k, v) => (typeof v === "bigint" ? String(v) : v),
    2,
  ),
);

if ((before.profile?.photos.length ?? 0) === 0) {
  console.warn(
    "\n⚠  This account has no profile photos. Liveness will pass but the " +
      "face-match step will land on pending_review (no_profile_photos).",
  );
}

await prisma.user.update({
  where: { id: before.id },
  data: {
    status: "onboarding",
    onboardingStep: "completed",
    verificationStatus: "unverified",
    verifiedAt: null,
    faceMatchedAt: null,
    faceMatchScore: null,
    personaInquiryId: null,
    ...(args["expire-selfie"] !== undefined ? { verifiedSelfiePath: null } : {}),
    ...(args.lang !== undefined ? { language: args.lang } : {}),
  },
});

console.log(
  "\n✓ AFTER — status=onboarding · onboardingStep=completed · verificationStatus=unverified",
);
if (args["expire-selfie"] !== undefined) {
  console.log("✓ verifiedSelfiePath cleared (simulates the 90-day GDPR scrub)");
}
if (args.lang !== undefined) {
  console.log(`✓ language set to "${args.lang}" — the detector reads this`);
}
console.log("\nSend /start to the dev bot — the verification gate will offer the Verify button.");

await prisma.$disconnect();
