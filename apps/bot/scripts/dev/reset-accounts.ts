/**
 * Dev-only: wipe specific Telegram accounts from the DEV database so /start
 * starts onboarding from scratch. Deletes the `User` row (Prisma `onDelete:
 * Cascade` clears profile, matches, tickets, reports, etc.) AND the grammY
 * `bot_sessions` row keyed by chat id (= telegram id for private chats), so no
 * stale FSM state survives.
 *
 * Refuses to run unless DATABASE_URL points at the dev DB (localhost:5434 /
 * gennety_dev) and DEV_OTP_BYPASS_TELEGRAM_IDS is set — двойная защита от
 * случайного запуска против прода.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reset-accounts.ts <id> [<id>...]
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reset-accounts.ts --apply <id> [<id>...]
 * Without --apply it's a dry run (reports what would be deleted).
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
    `[reset-accounts] refusing: DATABASE_URL is not the dev DB (need localhost:5434/gennety_dev).\n  got: ${url.replace(/:[^:@/]+@/, ":***@")}`,
  );
  process.exit(1);
}
if (!process.env.DEV_OTP_BYPASS_TELEGRAM_IDS) {
  console.error("[reset-accounts] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS empty (not a dev env)");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const ids = args.filter((a) => a !== "--apply").map((a) => BigInt(a.trim()));
if (ids.length === 0) {
  console.error("usage: reset-accounts.ts [--apply] <telegramId> [<telegramId>...]");
  process.exit(1);
}

const { prisma } = await import("@gennety/db");

for (const tgId of ids) {
  const user = await prisma.user.findUnique({
    where: { telegramId: tgId },
    select: { id: true, telegramId: true, firstName: true, status: true, onboardingStep: true },
  });
  const sessionKey = tgId.toString();
  const session = await prisma.botSession.findUnique({ where: { key: sessionKey } });

  console.log(`\n— telegramId ${tgId}`);
  console.log(
    `  user:    ${user ? `FOUND id=${user.id} name=${user.firstName ?? "?"} status=${user.status} step=${user.onboardingStep}` : "none"}`,
  );
  console.log(`  session: ${session ? "FOUND" : "none"}`);

  if (!apply) continue;

  if (user) {
    await prisma.user.delete({ where: { id: user.id } });
    console.log("  -> user deleted (cascade)");
  }
  if (session) {
    await prisma.botSession.delete({ where: { key: sessionKey } });
    console.log("  -> session deleted");
  }
}

console.log(apply ? "\n[reset-accounts] done." : "\n[reset-accounts] DRY RUN — re-run with --apply to delete.");
await prisma.$disconnect();
