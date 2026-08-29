import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import type { ActivityRow } from "./activity.js";
import { toDayKey } from "./activity.js";

/**
 * Loading for the DAU/MAU endpoints. Everything that knows about Prisma lives
 * here; the definitions stay pure in `activity.ts` (same split as
 * `user-health.ts` / `user-health-source.ts`).
 */

/**
 * Test accounts, from env rather than code — the list is per-operator (the
 * founder's own account, QA, demo) and adding one must not be a deploy. Read
 * once at module load; env does not change during a process.
 *
 * The same variable `admin/utils/user-health-source.ts` uses, deliberately: two
 * lists of "who is a test account" would eventually disagree, and then two
 * dashboards would show two different DAUs.
 */
const TEST_TELEGRAM_IDS = (env.ADMIN_TEST_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  })
  .filter((v): v is bigint => v !== null);

export interface LoadActivityOptions {
  /**
   * Include test and synthetic accounts. Off by default.
   *
   * Excluded on READ rather than on write, and that is the decision: the write
   * path stays dumb and complete, so who counts as a test account can be
   * changed — or debugged with `?includeTest=1` — without the underlying data
   * having been filtered away at the time it was collected.
   */
  includeTest?: boolean;
}

/**
 * Every `(day, user, platform)` row in `[from, to]`, minus test accounts.
 *
 * Excluding synthetic profiles is not tidiness here: production seeded 30 of
 * them (`User.syntheticAt`, PRODUCT_SPEC §3.1c) against ~20 real users, so
 * counting them would have overstated DAU several-fold. They are a matching
 * stand-in that never opens the bot — but a reconcile from `chat_events` could
 * still attribute rows to them, so the filter belongs here rather than being
 * assumed.
 */
export async function loadActivityRows(
  from: Date,
  to: Date,
  options: LoadActivityOptions = {},
): Promise<ActivityRow[]> {
  const rows = await prisma.userActivityDay.findMany({
    where: {
      activityDate: { gte: from, lte: to },
      ...(options.includeTest
        ? {}
        : {
            user: {
              syntheticAt: null,
              ...(TEST_TELEGRAM_IDS.length > 0
                ? { telegramId: { notIn: TEST_TELEGRAM_IDS } }
                : {}),
            },
          }),
    },
    select: { activityDate: true, userId: true, platform: true },
  });

  return rows.map((r) => ({
    day: toDayKey(r.activityDate),
    userId: r.userId,
    platform: r.platform,
  }));
}

/** How many test/synthetic accounts were left out, so the gap is stated. */
export async function countExcludedActive(from: Date, to: Date): Promise<number> {
  const [all, real] = await Promise.all([
    loadActivityRows(from, to, { includeTest: true }),
    loadActivityRows(from, to),
  ]);
  const realIds = new Set(real.map((r) => r.userId));
  const excluded = new Set(
    all.filter((r) => !realIds.has(r.userId)).map((r) => r.userId),
  );
  return excluded.size;
}

// ---------------------------------------------------------------------------
// Cohort retention loading
// ---------------------------------------------------------------------------

/**
 * The registration side of a cohort matrix.
 *
 * It lives here, beside `loadActivityRows`, on purpose: the numerator and the
 * denominator of a retention percentage have to describe the SAME population,
 * and the only way to guarantee that is for one module to own "who counts".
 * A denominator built from `classifyAllUsers` against a numerator built from
 * this file's filter would drift the day the two definitions of a test account
 * diverge, and the symptom would be a retention rate above 100%.
 */
export async function loadCohortUsers(
  from: Date,
  to: Date,
  options: LoadActivityOptions = {},
): Promise<Array<{ id: string; createdAt: Date; referralSource: string | null }>> {
  return prisma.user.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      ...(options.includeTest
        ? {}
        : {
            syntheticAt: null,
            ...(TEST_TELEGRAM_IDS.length > 0
              ? { telegramId: { notIn: TEST_TELEGRAM_IDS } }
              : {}),
          }),
    },
    select: { id: true, createdAt: true, referralSource: true },
  });
}

/** How many registrations in the window were left out, so the gap is stated. */
export async function countExcludedCohortUsers(from: Date, to: Date): Promise<number> {
  const [all, real] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: from, lte: to } } }),
    prisma.user.count({
      where: {
        createdAt: { gte: from, lte: to },
        syntheticAt: null,
        ...(TEST_TELEGRAM_IDS.length > 0
          ? { telegramId: { notIn: TEST_TELEGRAM_IDS } }
          : {}),
      },
    }),
  ]);
  return all - real;
}

/**
 * The earliest UTC day `user_activity_days` holds anything for — i.e. the
 * first day the instrument was switched on.
 *
 * This is what separates "nobody came back" from "we were not watching", and
 * it is load-bearing rather than decorative here: the table began collecting
 * in August 2026, so every cohort older than that would otherwise be reported
 * as 100% churned. `null` means the table is empty and nothing is measurable
 * yet — which is the state production is in until the backfill runs.
 *
 * Deliberately NOT filtered by test accounts: it answers "what does the table
 * cover", not "who is in it", and a synthetic row is still evidence that the
 * writer was alive that day.
 */
export async function activityCoverageFrom(): Promise<string | null> {
  const row = await prisma.userActivityDay.findFirst({
    orderBy: { activityDate: "asc" },
    select: { activityDate: true },
  });
  return row ? toDayKey(row.activityDate) : null;
}
