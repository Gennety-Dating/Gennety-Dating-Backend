/**
 * Local-dev only — seeds a `scheduled` Match in the past so the
 * date-lifecycle cron tick (every 2 minutes) fires the new T+24h
 * feedback DM against the local @gennetytestbot.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/seed-feedback-match.ts <telegramId>
 *
 * Side effects:
 *   - Creates a synthetic partner with telegramId = -<id> (negative so the
 *     cron's `telegramId > 0n` guard skips the partner DM).
 *   - Creates a Match where the real user is userA, synthetic is userB,
 *     `status=scheduled`, `agreedTime = now - 25h`, `feedbackPromptedAt = null`.
 *   - Doesn't touch profiles/embeddings — the cron only needs match + user
 *     identity columns.
 *
 * NOT for production. The seeded Match has no synergy/pitch/embedding —
 * it would not survive the matching invariants if the real engine ever
 * tried to re-process it.
 */
import { prisma } from "@gennety/db";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: tsx scripts/seed-feedback-match.ts <telegramId>");
    process.exit(1);
  }
  const telegramId = BigInt(arg);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, status: true, onboardingStep: true, firstName: true },
  });
  if (!user) {
    console.error(`No User with telegramId=${arg}. Run /start in @gennetytestbot first.`);
    process.exit(2);
  }
  if (user.onboardingStep !== "completed") {
    console.error(
      `User ${user.id} (${user.firstName ?? "?"}) is at onboardingStep=${user.onboardingStep}. ` +
        `Finish onboarding before seeding the feedback match.`,
    );
    process.exit(3);
  }

  const partnerTelegramId = -telegramId;
  const partner = await prisma.user.upsert({
    where: { telegramId: partnerTelegramId },
    create: {
      telegramId: partnerTelegramId,
      firstName: "Olivia",
      universityDomain: "stanford.edu",
      language: "en",
      status: "active",
      onboardingStep: "completed",
      hasConsented: true,
      termsAccepted: true,
      isEmailVerified: true,
    },
    update: {},
    select: { id: true, telegramId: true, firstName: true },
  });

  const agreedTime = new Date(Date.now() - 25 * 60 * 60 * 1000);

  const match = await prisma.match.create({
    data: {
      userAId: user.id,
      userBId: partner.id,
      status: "scheduled",
      agreedTime,
      // Cron needs feedbackPromptedAt: null to fire — explicit for clarity.
      feedbackPromptedAt: null,
    },
    select: { id: true, agreedTime: true },
  });

  console.log("Seeded feedback match:");
  console.log(`  matchId        = ${match.id}`);
  console.log(`  userA          = ${user.id} (tg=${arg}, ${user.firstName ?? "?"})`);
  console.log(`  userB (synth)  = ${partner.id} (tg=${partner.telegramId}, ${partner.firstName})`);
  console.log(`  status         = scheduled`);
  console.log(`  agreedTime     = ${match.agreedTime?.toISOString()} (~25h ago)`);
  console.log("");
  console.log("Date-lifecycle tick fires every 120s by default. Watch the bot log:");
  console.log("  tail -f /tmp/gennety-bot.log");
}

main()
  .catch((err: unknown) => {
    console.error("seed-feedback-match failed:", err);
    process.exit(99);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
