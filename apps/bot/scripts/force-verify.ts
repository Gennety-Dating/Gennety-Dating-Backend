/**
 * One-shot: manually run the face-match verification pipeline for a user
 * whose Persona inquiry got stuck at `completed` (no `approved` workflow).
 * Bypasses our `pullVerificationStatus` "approved-only" gate by calling
 * `runFaceMatchVerificationDefault` directly. Writes to DB, DMs the user.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/force-verify.ts <user-id-or-tg-or-email> [inquiry-id]
 *   (inquiry-id optional — script looks up the most recent one if omitted)
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const { prisma } = await import("@gennety/db");
const { Bot } = await import("grammy");
const { runFaceMatchVerificationDefault } = await import("../src/services/verification-pipeline.js");
const { fetchLatestInquiryByReference } = await import("../src/services/persona-api.js");

const arg = process.argv[2];
const inquiryArg = process.argv[3];
if (!arg) {
  console.error("usage: force-verify.ts <user-id|tg|email> [inquiry-id]");
  process.exit(1);
}

const select = {
  id: true,
  email: true,
  telegramId: true,
  status: true,
  verificationStatus: true,
  personaInquiryId: true,
  profile: { select: { photos: true } },
} as const;

let user = null as Awaited<ReturnType<typeof prisma.user.findFirst>> | null;
if (/^[0-9a-f-]{36}$/i.test(arg)) {
  user = await prisma.user.findUnique({ where: { id: arg }, select });
}
if (!user && arg.includes("@")) {
  user = await prisma.user.findFirst({ where: { email: arg }, select });
}
if (!user && /^-?\d+$/.test(arg)) {
  user = await prisma.user.findFirst({ where: { telegramId: BigInt(arg) }, select });
}
if (!user) {
  console.error(`user not found: ${arg}`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`User: ${user.id} (${user.email}, tg=${user.telegramId})`);
console.log(`Status: ${user.status}, verification: ${user.verificationStatus}`);
console.log(`Profile photos: ${user.profile?.photos.length ?? 0}`);

let inquiryId = inquiryArg ?? user.personaInquiryId;
if (!inquiryId) {
  console.log("Looking up latest inquiry via Persona REST...");
  const lookup = await fetchLatestInquiryByReference(user.id);
  if (!lookup.ok || !lookup.inquiryId) {
    console.error("could not find inquiry:", lookup);
    await prisma.$disconnect();
    process.exit(1);
  }
  inquiryId = lookup.inquiryId;
  console.log(`Found inquiry ${inquiryId} (status=${"status" in lookup ? lookup.status : "?"})`);
}

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN missing");
  await prisma.$disconnect();
  process.exit(1);
}
const bot = new Bot(token);

console.log(`\nForcing pipeline for inquiry ${inquiryId}…\n`);
const outcome = await runFaceMatchVerificationDefault(user.id, inquiryId, bot.api);
console.log("\nOutcome:", JSON.stringify(outcome, null, 2));

await prisma.$disconnect();
