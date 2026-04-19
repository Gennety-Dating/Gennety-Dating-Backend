import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";

/**
 * Rate-limited notifier for users whose `Profile.missedWeeks` was just
 * incremented by the weekly batch.
 *
 * Mirrors the `dispatchMatches` pattern: sequential sends with a fixed
 * delay between each to stay under Telegram per-user + per-second rate
 * limits. Platform gating matches the schema note at
 * `schema.prisma:103-105` — mobile-only users have a synthetic negative
 * `telegramId` and are silently skipped here (their push comes from the
 * Expo path, out of scope for this service).
 */

export const DEFAULT_NOTIFY_DELAY_MS = 2000;

export interface StarvationNotifyResult {
  notified: number;
  skipped: number;
  failed: number;
  errors: Array<{ userId: string; error: string }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send the "priority boosted" ping to each userId sequentially.
 *
 * Users with no Telegram presence (`telegramId <= 0`, i.e. mobile-first
 * accounts) are skipped — they get push via the Expo path.
 */
export async function notifyStarved(
  api: Api<RawApi>,
  userIds: string[],
  delayMs: number = DEFAULT_NOTIFY_DELAY_MS,
): Promise<StarvationNotifyResult> {
  if (userIds.length === 0) {
    return { notified: 0, skipped: 0, failed: 0, errors: [] };
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, telegramId: true, language: true },
  });

  let notified = 0;
  let skipped = 0;
  const errors: StarvationNotifyResult["errors"] = [];

  for (let i = 0; i < users.length; i++) {
    const u = users[i]!;

    // Mobile-first account — handled by the push path, not Telegram.
    if (u.telegramId <= 0n) {
      skipped++;
      continue;
    }

    const lang: Language = u.language ?? "en";
    try {
      await api.sendMessage(
        Number(u.telegramId),
        t(lang, "matchStarvationBoosted"),
      );
      notified++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ userId: u.id, error: message });
      console.error(
        `[starvation-notify] ${i + 1}/${users.length} userId=${u.id} FAILED: ${message}`,
      );
    }

    if (i < users.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `[starvation-notify] done: notified=${notified} skipped=${skipped} failed=${errors.length}`,
  );

  return { notified, skipped, failed: errors.length, errors };
}
