import { env } from "../config.js";

/**
 * Who counts as a real account in analytics. Lives in the services layer so
 * both the admin analytics (`admin/utils/activity-source.ts`, which re-exports
 * it) and the Pulse rollup (`services/pulse/source.ts`) read ONE list and ONE
 * filter — services must not import the admin layer (eslint layering rule).
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
export const TEST_TELEGRAM_IDS: bigint[] = (env.ADMIN_TEST_TELEGRAM_IDS ?? "")
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

/**
 * The `where` fragment that means "a real account", ready to spread into any
 * query whose subject is a `User` row.
 *
 * A K-factor whose denominator counts the founder's own test account and whose
 * numerator does not is not a smaller number, it is a wrong one. The comment on
 * `TEST_TELEGRAM_IDS` above says why there must be one list; this says why
 * there must be one FILTER.
 */
export function realUserFilter(includeTest = false): {
  syntheticAt?: null;
  telegramId?: { notIn: bigint[] };
} {
  if (includeTest) return {};
  return {
    syntheticAt: null,
    ...(TEST_TELEGRAM_IDS.length > 0 ? { telegramId: { notIn: TEST_TELEGRAM_IDS } } : {}),
  };
}
