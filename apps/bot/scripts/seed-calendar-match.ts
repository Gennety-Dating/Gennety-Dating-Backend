/**
 * Seed a synthetic `negotiating` match between two real Telegram users
 * who've already completed onboarding, then run `startScheduling` so
 * both users immediately receive the calendar Mini App button.
 *
 * Skips the pitch/accept stages — purely a tool for poking at the
 * calendar + concierge venue flows in @gennetytestbot without waiting
 * for the weekly batch.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/seed-calendar-match.ts \
 *     <telegramIdA> <telegramIdB>
 *
 * Side effects:
 *   - Wipes any prior match row between the pair so re-running is idempotent.
 *   - Inserts a single Match in `negotiating` with both `acceptedBy*` flags
 *     set true; `dispatchedAt = now`.
 *   - Calls `startScheduling` — writes the server-side DateTime allowlist
 *     (6 dates × 5 time slots) to `Match.proposedTimes`, pins
 *     `schedulingIteration=3`, and DMs the calendar button to both Telegram
 *     users via the dev bot token.
 *
 * NOT for production. The seeded match has no synergy/pitch/embedding,
 * which is fine for the calendar/venue downstream tests.
 */

// Load `.env.local` BEFORE importing anything that touches the DB or
// the bot — PrismaClient and the bot config both pull env at import time.
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { Api } = await import("grammy");
const { prisma } = await import("@gennety/db");
const { startScheduling } = await import("../src/handlers/matching/scheduler.js");

async function main(): Promise<void> {
  const [aRaw, bRaw] = process.argv.slice(2);
  if (!aRaw || !bRaw) {
    console.error(
      "Usage: tsx scripts/seed-calendar-match.ts <telegramIdA> <telegramIdB>",
    );
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
  // SAFETY: refuse to run if the loaded BOT_TOKEN looks like the prod one.
  // Dev bot is `@gennetytestbot`, prod is `@gennetybot` — quick guard so a
  // misread `.env` can't blast calendar DMs to real users.
  const me = await new Api(botToken).getMe();
  if (me.username && me.username !== "gennetytestbot") {
    console.error(
      `Refusing to seed: connected bot is @${me.username}, expected @gennetytestbot. ` +
        `Check that .env.local was loaded (DATABASE_URL should target localhost:5434).`,
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

  // Clean any prior match row between the pair so this script is idempotent.
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
      status: "negotiating",
      acceptedByA: true,
      acceptedByB: true,
      dispatchedAt: new Date(),
      // Cosmetic: a synergy score so the dashboard doesn't render a 0.
      synergyScore: 88,
      synergyReason: "Seeded match — pitch/accept stages skipped for calendar testing.",
    },
    select: { id: true },
  });
  console.log(`Created Match id=${match.id} in 'negotiating' (both accepted).`);

  // Use a fresh Api directly — independent of whether `pnpm dev:bot` is
  // currently long-polling. Outbound sendMessage works regardless.
  const api = new Api(botToken) as never;
  await startScheduling(api, match.id);
  console.log(
    `\n✅ Calendar buttons dispatched to:\n` +
      `   - @${userA.firstName ?? "A"} (telegram=${tgA})\n` +
      `   - @${userB.firstName ?? "B"} (telegram=${tgB})\n\n` +
      `Both users should see a DM with "📅 Open Calendar" in @gennetytestbot.\n` +
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
