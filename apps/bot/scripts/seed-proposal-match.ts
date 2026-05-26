/**
 * Local-dev only: seed a `proposed` match between two real Telegram users,
 * then dispatch the normal pitch with Accept / Decline buttons.
 *
 * This is the E2E QA path when we want to test the real proposal decision
 * flow before the Calendar Mini App. After both users tap Accept, the normal
 * bot handler transitions the match to `negotiating` and calls startScheduling.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/seed-proposal-match.ts \
 *     <telegramIdA> <telegramIdB>
 *
 * NOT for production. The row is synthetic and bypasses the match engine.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { Api } = await import("grammy");
const { prisma } = await import("@gennety/db");
const { dispatchMatches } = await import("../src/services/dispatch-queue.js");

async function main(): Promise<void> {
  const [aRaw, bRaw] = process.argv.slice(2);
  if (!aRaw || !bRaw) {
    console.error("Usage: tsx scripts/seed-proposal-match.ts <telegramIdA> <telegramIdB>");
    process.exit(1);
  }

  const tgA = BigInt(aRaw);
  const tgB = BigInt(bRaw);
  if (tgA === tgB) {
    console.error("Both Telegram IDs must be distinct.");
    process.exit(1);
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    console.error("BOT_TOKEN missing from .env.local — did the dev env load?");
    process.exit(1);
  }

  const api = new Api(botToken);
  const me = await api.getMe();
  if (me.username && me.username !== "gennetytestbot") {
    console.error(
      `Refusing to seed: connected bot is @${me.username}, expected @gennetytestbot. ` +
        "Check that .env.local was loaded.",
    );
    process.exit(2);
  }
  console.log(`Connected as @${me.username} (id=${me.id}).`);

  const userA = await prisma.user.findUnique({
    where: { telegramId: tgA },
    select: {
      id: true,
      firstName: true,
      onboardingStep: true,
      status: true,
      language: true,
    },
  });
  const userB = await prisma.user.findUnique({
    where: { telegramId: tgB },
    select: {
      id: true,
      firstName: true,
      onboardingStep: true,
      status: true,
      language: true,
    },
  });

  if (!userA) {
    console.error(`No User with telegramId=${tgA}. Run /start in @gennetytestbot first.`);
    process.exit(3);
  }
  if (!userB) {
    console.error(`No User with telegramId=${tgB}. Run /start in @gennetytestbot first.`);
    process.exit(3);
  }

  for (const u of [
    { tg: tgA, row: userA, label: "A" },
    { tg: tgB, row: userB, label: "B" },
  ]) {
    if (u.row.onboardingStep !== "completed") {
      console.error(
        `User ${u.label} (telegram=${u.tg}, ${u.row.firstName ?? "?"}) is at ` +
          `onboardingStep=${u.row.onboardingStep}. Both users must finish onboarding first.`,
      );
      process.exit(4);
    }
  }

  const wiped = await prisma.match.deleteMany({
    where: {
      OR: [
        { userAId: userA.id, userBId: userB.id },
        { userAId: userB.id, userBId: userA.id },
      ],
    },
  });
  if (wiped.count > 0) {
    console.log(`Wiped ${wiped.count} prior match row(s) between the pair.`);
  }

  const match = await prisma.match.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      status: "proposed",
      acceptedByA: null,
      acceptedByB: null,
    },
    select: { id: true },
  });
  console.log(`Created Match id=${match.id} in 'proposed'.`);

  const result = await dispatchMatches(api as never, [match.id], 0);
  if (result.failed > 0) {
    console.error("Dispatch failed:", JSON.stringify(result.errors, null, 2));
    process.exit(5);
  }

  console.log(
    "\n✅ Proposal dispatched. Both users should see the normal match pitch " +
      "with Accept / Decline buttons.\n" +
      `Match id: ${match.id}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    void prisma.$disconnect();
    process.exit(1);
  });
