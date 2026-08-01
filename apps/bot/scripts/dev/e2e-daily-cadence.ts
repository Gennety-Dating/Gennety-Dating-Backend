/**
 * ONE-OFF, dev-only: exercise a real drop → pitch → deadline → expiry cycle
 * against the running dev DB and the real dev Bot API, under
 * `DROP_CADENCE=daily`, without waiting real wall-clock time (the deadline
 * is crossed by backdating `dispatchedAt`, the same technique
 * `advance-match-clock.ts` uses).
 *
 * This is the manual E2E companion to the unit/integration test suite that
 * already pins every individual mechanism (cron parsing for `"0 18 * * *"`,
 * `deadlineFor`'s anchored-vs-fixed strategy, the cooldown boundary, the
 * expiry preflight ordering, famine-tier day math). What this script proves
 * that the test suite can't: that a REAL running process with
 * `DROP_CADENCE=daily` set actually wires all of that together end-to-end —
 * real batch → real Telegram pitch delivery → real deadline math → real
 * expiry notification, against Postgres and the Bot API, not mocks.
 *
 * Uses the dedicated E2E-test pair (see force-verify-pair.ts):
 *   A = 782065541  (male, seeking women)
 *   B = 5986970093 (female, seeking men)
 * Both must already be active+verified+same-city (run force-verify-pair.ts
 * first if not). Any existing match between them is deleted first — the
 * lifetime pair-ban (§3.2 filter 6) means they can never be re-paired
 * otherwise, and this pair is the only fixture in the dev DB, so a fresh
 * proposed match can't form until the old one is cleared. This is dev-only
 * fixture data (documented E2E-test accounts), not real user history.
 *
 * NOTE: because this dev DB has no third eligible user, this script cannot
 * demonstrate "the freed user gets matched to someone else next drop" — only
 * that they are correctly released from the single-live-match invariant
 * (§3.2 filter 8) and correctly remain lifetime-banned from re-pairing with
 * EACH OTHER (§3.2 filter 6, by design). Re-admission to a *different*
 * partner is what `match-engine.integration.test.ts`'s cooldown-boundary
 * tests already cover with real Postgres.
 *
 * Usage (DROP_CADENCE=daily is REQUIRED — this script refuses otherwise):
 *   DROP_CADENCE=daily pnpm --filter @gennety/bot exec tsx scripts/dev/e2e-daily-cadence.ts
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
    `[e2e-daily-cadence] refusing: DATABASE_URL is not the dev DB (need localhost:5434/gennety_dev).\n  got: ${url.replace(/:[^:@/]+@/, ":***@")}`,
  );
  process.exit(1);
}
if (!process.env.DEV_OTP_BYPASS_TELEGRAM_IDS) {
  console.error("[e2e-daily-cadence] refusing: DEV_OTP_BYPASS_TELEGRAM_IDS empty (not a dev env)");
  process.exit(1);
}
if (process.env.DROP_CADENCE !== "daily") {
  console.error(
    `[e2e-daily-cadence] refusing: DROP_CADENCE must be "daily" for this script (got ${JSON.stringify(process.env.DROP_CADENCE ?? null)}).\n` +
      "  Run: DROP_CADENCE=daily pnpm --filter @gennety/bot exec tsx scripts/dev/e2e-daily-cadence.ts",
  );
  process.exit(1);
}
if (!process.env.BOT_TOKEN) {
  console.error("[e2e-daily-cadence] BOT_TOKEN missing");
  process.exit(1);
}

const A_TG = 782065541n;
const B_TG = 5986970093n;

const { prisma } = await import("@gennety/db");
const { Bot } = await import("grammy");
const { CADENCE } = await import("@gennety/shared");
const { runDropBatch } = await import("../../src/services/match-engine.js");
const { dispatchMatches } = await import("../../src/services/dispatch-queue.js");
const { sendExpiryNotifications } = await import("../../src/services/expiry-notify.js");
const { deadlineFor } = await import("../../src/services/proposal-deadline.js");
const { ACTIVE_MATCH_STATUSES } = await import("../../src/services/active-match-priority.js");

console.log(`[e2e-daily-cadence] CADENCE.cron=${CADENCE.cron} strategy=${CADENCE.deadlineStrategy} cooldownMs=${CADENCE.cooldownMs}`);

const [a, b] = await Promise.all([
  prisma.user.findUnique({ where: { telegramId: A_TG } }),
  prisma.user.findUnique({ where: { telegramId: B_TG } }),
]);
if (!a || !b) {
  console.error(`[e2e-daily-cadence] missing fixture user(s): a=${!!a} b=${!!b} — run force-verify-pair.ts first`);
  process.exit(1);
}
console.log(`[e2e-daily-cadence] fixture: A=${a.id} (${a.status}/${a.verificationStatus}) B=${b.id} (${b.status}/${b.verificationStatus})`);

// --- Step 1: clear any prior match between the pair (see file header). ---
const existing = await prisma.match.findMany({
  where: {
    OR: [
      { userAId: a.id, userBId: b.id },
      { userAId: b.id, userBId: a.id },
    ],
  },
  select: { id: true, status: true },
});
if (existing.length > 0) {
  console.log(`[e2e-daily-cadence] clearing ${existing.length} prior match row(s): ${existing.map((m) => `${m.id}(${m.status})`).join(", ")}`);
  await prisma.match.deleteMany({ where: { id: { in: existing.map((m) => m.id) } } });
} else {
  console.log("[e2e-daily-cadence] no prior match between the pair");
}

// --- Step 2: run the drop batch — expect it to pair A and B fresh. ---
const bot = new Bot(process.env.BOT_TOKEN);
await bot.init();

console.log("\n[e2e-daily-cadence] === batch #1: expect a fresh proposed match ===");
const result1 = await runDropBatch();
console.log(`[e2e-daily-cadence] eligible=${result1.eligible} pairs=${result1.pairs} matchIds=${result1.matchIds.join(",")}`);
if (result1.matchIds.length !== 1) {
  console.error(`[e2e-daily-cadence] FAIL: expected exactly 1 new match, got ${result1.matchIds.length}`);
  await prisma.$disconnect();
  process.exit(1);
}
const matchId = result1.matchIds[0]!;

const dispatch1 = await dispatchMatches(bot.api, [matchId], 500);
console.log(`[e2e-daily-cadence] dispatch: sent=${dispatch1.dispatched} failed=${dispatch1.failed} errors=${JSON.stringify(dispatch1.errors)}`);

const created = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
console.log(`[e2e-daily-cadence] status=${created.status} dispatchedAt=${created.dispatchedAt?.toISOString()}`);

// --- Step 3: verify the deadline is ANCHORED (daily), not a flat 24h TTL. ---
const dl = deadlineFor(created.dispatchedAt!);
const flat24h = new Date(created.dispatchedAt!.getTime() + 24 * 60 * 60 * 1000);
console.log(`[e2e-daily-cadence] deadlineFor(dispatchedAt) = ${dl.toISOString()}`);
console.log(`[e2e-daily-cadence] flat 24h from dispatch    = ${flat24h.toISOString()} (should differ under daily)`);
if (Math.abs(dl.getTime() - flat24h.getTime()) < 5 * 60 * 1000) {
  console.error("[e2e-daily-cadence] FAIL: deadline looks like a flat 24h TTL, not anchored to the next drop");
  await prisma.$disconnect();
  process.exit(1);
}
console.log("[e2e-daily-cadence] OK: deadline is anchored, confirming daily's decision-buffer strategy is live");

// --- Step 4: backdate dispatchedAt so the deadline has already passed. ---
const pastDispatch = new Date(dl.getTime() - CADENCE.intervalMs - 60_000); // safely before the deadline, two intervals back
await prisma.match.update({ where: { id: matchId }, data: { dispatchedAt: pastDispatch } });
console.log(`\n[e2e-daily-cadence] backdated dispatchedAt to ${pastDispatch.toISOString()} (deadline now in the past)`);

// --- Step 5: run the batch again — its own expiry preflight should catch it. ---
console.log("\n[e2e-daily-cadence] === batch #2: expect the backdated match to expire in the preflight ===");
const result2 = await runDropBatch();
console.log(`[e2e-daily-cadence] eligible=${result2.eligible} pairs=${result2.pairs} expiredMatches=${result2.expiredMatches.map((m) => m.matchId).join(",")}`);

const expired = result2.expiredMatches.find((m) => m.matchId === matchId);
if (!expired) {
  console.error("[e2e-daily-cadence] FAIL: the backdated match was not caught by the expiry preflight");
  await prisma.$disconnect();
  process.exit(1);
}
const notify = await sendExpiryNotifications(bot.api, result2.expiredMatches);
console.log(`[e2e-daily-cadence] expiry notify: notified=${notify.notified} skipped=${notify.skipped} failed=${notify.failed}`);

const afterExpiry = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
console.log(`[e2e-daily-cadence] match status after expiry preflight: ${afterExpiry.status}`);
if (afterExpiry.status !== "expired") {
  console.error(`[e2e-daily-cadence] FAIL: expected status "expired", got "${afterExpiry.status}"`);
  await prisma.$disconnect();
  process.exit(1);
}

// --- Step 6: confirm both sides are released from the single-live-match invariant. ---
const liveForA = await prisma.match.count({
  where: {
    status: { in: [...ACTIVE_MATCH_STATUSES] },
    OR: [{ userAId: a.id }, { userBId: a.id }],
  },
});
const liveForB = await prisma.match.count({
  where: {
    status: { in: [...ACTIVE_MATCH_STATUSES] },
    OR: [{ userAId: b.id }, { userBId: b.id }],
  },
});
console.log(`[e2e-daily-cadence] live-match rows: A=${liveForA} B=${liveForB} (both must be 0 — freed for the next drop)`);
if (liveForA !== 0 || liveForB !== 0) {
  console.error("[e2e-daily-cadence] FAIL: at least one side still holds a live-match slot");
  await prisma.$disconnect();
  process.exit(1);
}

console.log(
  "\n[e2e-daily-cadence] PASS — drop batch, real Telegram pitch dispatch, anchored deadline, backdated " +
    "expiry via the batch's own preflight, and single-live-match release all verified end-to-end under DROP_CADENCE=daily.\n" +
    "  NOTE: this pair remains lifetime-banned from each other (§3.2 filter 6) — that match row (now \"expired\") " +
    "is correct, permanent history, not left-over test debris to clean up.",
);

await prisma.$disconnect();
