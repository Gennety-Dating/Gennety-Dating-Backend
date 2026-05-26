#!/usr/bin/env node
/**
 * Dev-only E2E helper.
 *
 * Copies the primary test user's verified university domain onto the secondary
 * Telegram account and marks the secondary email as verified. This preserves
 * the same-university matching invariant while avoiding the need for a second
 * real corporate inbox during local DEP-bot testing.
 *
 * Usage:
 *   node scripts/dev-align-email-bypass.mjs --apply
 *
 * Optional:
 *   --primary-tg=782065541 --secondary-tg=5986970093 --force
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "@gennety/db";

const root = resolve(import.meta.dirname, "..");
const localEnv = resolve(root, ".env.local");
if (existsSync(localEnv)) config({ path: localEnv });
config({ path: resolve(root, ".env") });

const args = new Map(
  process.argv.slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value = "true"] = arg.slice(2).split("=");
      return [key, value];
    }),
);

const apply = args.get("apply") === "true";
const force = args.get("force") === "true";
const primaryTg = BigInt(args.get("primary-tg") ?? "782065541");
const secondaryTg = BigInt(args.get("secondary-tg") ?? "5986970093");

function maskEmail(email) {
  if (!email || typeof email !== "string") return null;
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[masked]";
  return `${local.slice(0, 2)}***@${domain}`;
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      "Refusing to run outside the DEP bot. Expected BOT_USERNAME=gennetytestbot; pass --force only if you are absolutely sure.",
    );
  }

  const primary = await prisma.user.findUnique({
    where: { telegramId: primaryTg },
    select: {
      id: true,
      telegramId: true,
      email: true,
      universityDomain: true,
      isEmailVerified: true,
    },
  });

  if (!primary) {
    throw new Error(`Primary Telegram user ${primaryTg.toString()} does not exist yet.`);
  }
  if (!primary.isEmailVerified || !primary.universityDomain) {
    throw new Error(
      `Primary Telegram user ${primaryTg.toString()} must have a verified email and universityDomain first.`,
    );
  }

  const syntheticEmail = `dev+${secondaryTg.toString()}@${primary.universityDomain}`;
  const existingEmailOwner = await prisma.user.findUnique({
    where: { email: syntheticEmail },
    select: { telegramId: true },
  });
  if (existingEmailOwner && existingEmailOwner.telegramId !== secondaryTg) {
    throw new Error(`Synthetic email ${syntheticEmail} is already owned by another user.`);
  }

  const secondary = await prisma.user.findUnique({
    where: { telegramId: secondaryTg },
    select: {
      id: true,
      telegramId: true,
      email: true,
      universityDomain: true,
      isEmailVerified: true,
    },
  });

  const next = {
    email: syntheticEmail,
    universityDomain: primary.universityDomain,
    isEmailVerified: true,
    emailOtp: null,
    emailOtpExpiresAt: null,
  };

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    primary: {
      telegramId: primary.telegramId.toString(),
      email: maskEmail(primary.email),
      universityDomain: primary.universityDomain,
    },
    secondaryBefore: secondary
      ? {
          telegramId: secondary.telegramId.toString(),
          email: maskEmail(secondary.email),
          universityDomain: secondary.universityDomain,
          isEmailVerified: secondary.isEmailVerified,
        }
      : null,
    secondaryAfter: {
      telegramId: secondaryTg.toString(),
      email: maskEmail(syntheticEmail),
      universityDomain: primary.universityDomain,
      isEmailVerified: true,
    },
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write the secondary account.");
    return;
  }

  await prisma.user.upsert({
    where: { telegramId: secondaryTg },
    update: next,
    create: {
      telegramId: secondaryTg,
      firstName: null,
      ...next,
    },
  });

  console.log("Secondary test account email gate aligned.");
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
