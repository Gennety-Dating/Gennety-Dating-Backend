/**
 * Quick state snapshot for the dev DB. Reads users + match counts so we can
 * confirm Pass 1 starts from a known state (clean, or already populated by
 * earlier test sessions).
 *
 * Usage: pnpm --filter @gennety/bot exec tsx scripts/dev/db-snapshot.ts
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const { prisma } = await import("@gennety/db");

const users = await prisma.user.findMany({
  select: {
    id: true,
    telegramId: true,
    email: true,
    onboardingStep: true,
    status: true,
    verificationStatus: true,
    isEmailVerified: true,
    createdAt: true,
  },
  orderBy: { createdAt: "desc" },
});

console.log(`users: ${users.length}`);
for (const u of users) {
  console.log(
    `  tg=${u.telegramId} step=${u.onboardingStep} status=${u.status} verif=${u.verificationStatus} emailVerified=${u.isEmailVerified} email=${u.email} created=${u.createdAt.toISOString()}`,
  );
}

const matchCount = await prisma.match.count();
const matchByStatus = await prisma.match.groupBy({
  by: ["status"],
  _count: { _all: true },
});
console.log(`matches: ${matchCount}`);
for (const row of matchByStatus) {
  console.log(`  ${row.status}: ${row._count._all}`);
}

await prisma.$disconnect();
