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
