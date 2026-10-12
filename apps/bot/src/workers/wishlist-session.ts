import { prisma } from "@gennety/db";
import { afterDateT, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { sendPushToUser } from "../services/push.js";
import { hasActiveDatePlanning } from "../services/profiler.js";
import { isQuietHourLocal, nextWindowAt, resolveZone } from "../services/profiler-schedule.js";
import { openWishlistSession, wishlistSessionEligible } from "../services/wishlist.js";
import { sweepWebLookupCache, warmWishlistCatalog } from "../services/wishlist-lookup.js";

/**
 * The Date Wishlist session's push (decision journal 2026-10-08): "Пользователю
 * приходит уведомление, он переходит на экран «Сегодня»".
 *
 * The app also opens the session on its own pull (`profiler-native.ts`); this
 * tick is what reaches a person who has not opened the app at their window. It
 * runs on the Profiler's cadence and does exactly what the pull would: when a
 * batch slot is due (the person's 09:00 / 18:00 window, outside quiet hours),
 * no question is live and no date is being planned, the slot goes to the
 * wishlist — claimed by compare-and-set, consumed like a batch — and ONE push
 * says so. Never the first batches, never twice once done, app users only
 * (`wishlistSessionEligible`).
 *
 * Housekeeping rides along: a few catalog photos are resolved per tick, and
 * expired look-ups are swept.
 */

const CANDIDATES_PER_TICK = 200;
const CATALOG_WARM_PER_TICK = 3;

export async function wishlistSessionTick(
  now: Date = new Date(),
): Promise<{ opened: number; warmed: number; swept: number }> {
  if (!env.WISHLIST_FEATURE_ENABLED) return { opened: 0, warmed: 0, swept: 0 };

  const rows = await prisma.profile.findMany({
    where: {
      wishlistOfferedAt: null,
      wishlistDoneAt: null,
      profilerActiveQuestionId: null,
      OR: [{ profilerNextAt: null }, { profilerNextAt: { lte: now } }],
      AND: [
        { OR: [{ wishlistSnoozedUntil: null }, { wishlistSnoozedUntil: { lte: now } }] },
      ],
      user: {
        status: "active",
        onboardingStep: "completed",
        platform: { in: ["mobile", "both"] },
      },
    },
    select: {
      userId: true,
      timeZone: true,
      profilerNextAt: true,
      user: { select: { language: true } },
    },
    take: CANDIDATES_PER_TICK,
  });

  let opened = 0;
  for (const row of rows) {
    if (isQuietHourLocal(now, row.timeZone)) continue;
    if (!(await wishlistSessionEligible(row.userId, now))) continue;
    if (await hasActiveDatePlanning(row.userId)) continue;
    if (!(await openWishlistSession(row.userId, now))) continue;
    await prisma.profile.updateMany({
      where: { userId: row.userId, profilerActiveQuestionId: null, profilerNextAt: row.profilerNextAt },
      data: { profilerBatchRemaining: 0, profilerNextAt: nextWindowAt(now, resolveZone(row.timeZone)) },
    });
    const lang = (row.user.language ?? "en") as Language;
    await sendPushToUser(row.userId, {
      title: afterDateT(lang, "wishlistSessionPushTitle"),
      body: afterDateT(lang, "wishlistSessionPushBody"),
      data: { type: "wishlist.session" },
      collapseId: "wishlist-session",
    }).catch(() => false);
    opened++;
  }

  const [warmed, swept] = await Promise.all([
    warmWishlistCatalog(CATALOG_WARM_PER_TICK, now).catch(() => 0),
    sweepWebLookupCache(now).catch(() => 0),
  ]);
  return { opened, warmed, swept };
}
