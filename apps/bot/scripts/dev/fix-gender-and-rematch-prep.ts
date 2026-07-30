/**
 * ONE-OFF, dev-only: the operator reported that after the earlier
 * force-verify-pair.ts gender fix, the PHOTOS turned out to be swapped
 * relative to gender — A (782065541) is labelled male but has the female
 * tester's photos; B (5986970093) is labelled female but has the male
 * tester's photos. Since neither account's photos were literally moved
 * between rows, the fix is to swap gender+preference (and B's first name,
 * since "Аліна" no longer fits) back so each account's declared identity
 * matches its own already-uploaded photos:
 *   A -> female / men   (reverts the earlier swap — her real photos)
 *   B -> male   / women (his real photos), firstName -> "Назар"
 *
 * Then deletes the existing `proposed` match row between them so a fresh
 * `dev:trigger-test-match` can create+dispatch a new pitch with the
 * corrected profiles. This is required because `createProposedMatch`'s
 * lifetime-pair-ban check matches on { userAId, userBId } with NO status
 * filter — cancelling alone would still block re-creation.
 *
 * Refuses to run unless DATABASE_URL points at the dev DB and
 * DEV_OTP_BYPASS_TELEGRAM_IDS is non-empty (same guard as sibling scripts).
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/fix-gender-and-rematch-prep.ts
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/fix-gender-and-rematch-prep.ts --apply
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const url = process.env.DATABASE_URL ?? "";
const isDevDb = url.includes("5434") && url.includes("gennety_dev");
if (!isDevDb) {
  console.error(
    `[fix-gender-and-rematch-prep] refusing: DATABASE_URL is not the dev DB.\n  got: ${url.replace(/:[^:@/]+@/, ":***@")}`,
  );
  process.exit(1);
}
if (!process.env.DEV_OTP_BYPASS_TELEGRAM_IDS) {
  console.error("[fix-gender-and-rematch-prep] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS empty (not a dev env)");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

const A_TG = 782065541n;
const B_TG = 5986970093n;

const { prisma } = await import("@gennety/db");

const [a, b] = await Promise.all([
  prisma.user.findUnique({ where: { telegramId: A_TG } }),
  prisma.user.findUnique({ where: { telegramId: B_TG } }),
]);
if (!a || !b) {
  console.error(`[fix-gender-and-rematch-prep] missing user(s): a=${!!a} b=${!!b}`);
  process.exit(1);
}

const openMatches = await prisma.match.findMany({
  where: {
    OR: [
      { userAId: a.id, userBId: b.id },
      { userAId: b.id, userBId: a.id },
    ],
  },
  select: { id: true, status: true, acceptedByA: true, acceptedByB: true },
});

console.log("before:");
console.log(`  A tg=${a.telegramId} firstName=${a.firstName} gender=${a.gender} preference=${a.preference}`);
console.log(`  B tg=${b.telegramId} firstName=${b.firstName} gender=${b.gender} preference=${b.preference}`);
console.log(`  existing match rows for this pair: ${JSON.stringify(openMatches)}`);

if (!apply) {
  console.log("\n(dry run — pass --apply to write)");
  process.exit(0);
}

await prisma.$transaction(async (tx) => {
  await tx.user.update({
    where: { id: a.id },
    data: { gender: "female", preference: "men" },
  });
  await tx.user.update({
    where: { id: b.id },
    data: { gender: "male", preference: "women", firstName: "Назар" },
  });
  if (openMatches.length > 0) {
    await tx.match.deleteMany({
      where: { id: { in: openMatches.map((m) => m.id) } },
    });
  }
});

const [a2, b2, remaining] = await Promise.all([
  prisma.user.findUnique({ where: { telegramId: A_TG } }),
  prisma.user.findUnique({ where: { telegramId: B_TG } }),
  prisma.match.findMany({
    where: {
      OR: [
        { userAId: a.id, userBId: b.id },
        { userAId: b.id, userBId: a.id },
      ],
    },
    select: { id: true },
  }),
]);

console.log("\nafter:");
console.log(`  A tg=${a2?.telegramId} firstName=${a2?.firstName} gender=${a2?.gender} preference=${a2?.preference}`);
console.log(`  B tg=${b2?.telegramId} firstName=${b2?.firstName} gender=${b2?.gender} preference=${b2?.preference}`);
console.log(`  remaining match rows for this pair: ${remaining.length}`);

process.exit(0);
