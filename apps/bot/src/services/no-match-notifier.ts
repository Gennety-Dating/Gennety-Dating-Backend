import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language, type TranslationKey } from "@gennety/shared";

/**
 * Empathetic "no match this week" DM.
 *
 * Fires ~15 min after the Thursday batch (`MATCH_CRON_SCHEDULE`) for every
 * `active` user that the matcher couldn't pair. Replaces the old
 * `notifyStarved` flow — we send one well-crafted message instead of the
 * curt "10/10 not found" ping. Tone escalates with consecutive famine
 * weeks (tier 1 → 2 → 3+) using `NoMatchNotice` history as the source of
 * truth for the streak counter.
 *
 * The query intentionally re-derives "who has no match this drop" from
 * the DB (active users without a `Match.dispatchedAt` in the last hour)
 * instead of being handed a list from `runWeeklyBatch` — this keeps the
 * cron safe to re-run / fire late without state coupling.
 */

export const DEFAULT_NOTIFY_DELAY_MS = 2000;

/**
 * Window (ms) used to decide whether a user "got matched in this drop".
 * Cron fires 15 min after the batch; dispatch takes a few minutes — a
 * 1-hour window comfortably covers both while excluding any stale matches.
 */
const RECENT_MATCH_WINDOW_MS = 60 * 60 * 1000;

export interface NoMatchNotifyResult {
  notified: number;
  skipped: number;
  failed: number;
  tier1: number;
  tier2: number;
  tier3plus: number;
  errors: Array<{ userId: string; error: string }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Floors `now` to UTC midnight of the same day. Used as the dedup key for
 * `NoMatchNotice` — the cron fires once per Thursday so day-granularity is
 * sufficient and `@@unique([userId, dropDate])` blocks accidental re-fires
 * within the same drop.
 */
export function getDropDate(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Tier = consecutive drops without a match, starting at 1 for the current
 * drop. We count `NoMatchNotice` rows since the user's most recent
 * dispatched match (or since they joined) and add 1 for the in-progress
 * drop. Capped to 3 by the caller when picking a template.
 */
async function computeTier(userId: string, dropDate: Date): Promise<number> {
  const lastMatch = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      dispatchedAt: { not: null },
    },
    orderBy: { dispatchedAt: "desc" },
    select: { dispatchedAt: true },
  });

  const sinceDate = lastMatch?.dispatchedAt ?? new Date(0);
  const priorNotices = await prisma.noMatchNotice.count({
    where: {
      userId,
      dropDate: { gt: sinceDate, lt: dropDate },
    },
  });

  return priorNotices + 1;
}

function templateKeyForTier(tier: number): TranslationKey {
  if (tier <= 1) return "noMatchThisWeekTier1";
  if (tier === 2) return "noMatchThisWeekTier2";
  return "noMatchThisWeekTier3";
}

/**
 * Find all `active` users with no dispatched match in the last
 * `RECENT_MATCH_WINDOW_MS`, send each the tier-appropriate DM, and record
 * a `NoMatchNotice` row for analytics + idempotency.
 *
 * Mobile-only accounts (`telegramId <= 0`) are skipped — push goes via
 * the Expo path; not in scope for this service.
 */
export async function sendNoMatchNotices(
  api: Api<RawApi>,
  now: Date = new Date(),
  delayMs: number = DEFAULT_NOTIFY_DELAY_MS,
): Promise<NoMatchNotifyResult> {
  const dropDate = getDropDate(now);
  const recentSince = new Date(now.getTime() - RECENT_MATCH_WINDOW_MS);

  const candidates = await prisma.user.findMany({
    where: {
      status: "active",
      onboardingStep: "completed",
      // Exclude users who got a match dispatched in this drop window
      AND: [
        {
          matchesAsA: {
            none: { dispatchedAt: { gte: recentSince } },
          },
        },
        {
          matchesAsB: {
            none: { dispatchedAt: { gte: recentSince } },
          },
        },
        // Idempotency: skip users who already received a notice for this drop
        {
          noMatchNotices: {
            none: { dropDate },
          },
        },
      ],
    },
    select: { id: true, telegramId: true, language: true },
  });

  const result: NoMatchNotifyResult = {
    notified: 0,
    skipped: 0,
    failed: 0,
    tier1: 0,
    tier2: 0,
    tier3plus: 0,
    errors: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i]!;

    // Mobile-first account — handled by the push path, not Telegram.
    if (u.telegramId <= 0n) {
      result.skipped++;
      continue;
    }

    const tier = await computeTier(u.id, dropDate);
    const lang: Language = u.language ?? "en";
    const body = t(lang, templateKeyForTier(tier), {});

    try {
      await prisma.noMatchNotice.create({
        data: { userId: u.id, tier, dropDate },
      });

      await api.sendMessage(Number(u.telegramId), body, {
        parse_mode: "Markdown",
      });

      result.notified++;
      if (tier === 1) result.tier1++;
      else if (tier === 2) result.tier2++;
      else result.tier3plus++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ userId: u.id, error: message });
      result.failed++;
      console.error(
        `[no-match-notify] ${i + 1}/${candidates.length} userId=${u.id} FAILED: ${message}`,
      );
    }

    if (i < candidates.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `[no-match-notify] done: notified=${result.notified} tier1=${result.tier1} tier2=${result.tier2} tier3plus=${result.tier3plus} skipped=${result.skipped} failed=${result.failed}`,
  );

  return result;
}
