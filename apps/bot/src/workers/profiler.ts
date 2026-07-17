import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  isQuietHourLocal,
  nextWindowAt,
  resolveZone,
} from "../services/profiler-schedule.js";
import { hasActiveDatePlanning, startProfilerBatch } from "../services/profiler.js";

/**
 * Profiler scheduler tick (PRODUCT_SPEC §Phase 1b). Runs on a cron (default
 * every 15 min). Two responsibilities:
 *
 *   1. **Lazy seed** — arm the Profiler for active, onboarding-complete
 *      Telegram users that don't have it yet (legacy rows / paths that bypass
 *      the finalize hook). First question lands at the next daily window.
 *   2. **Dispatch** — start a batch for every user whose `profilerNextAt` is
 *      due, deferring out of the user's local quiet hours and while the user is
 *      mid date-negotiation (pitch decision / scheduling / venue selection).
 *
 * Telegram-only in v1 (mobile-first users carry a negative `telegramId`).
 */

const MAX_SEED_PER_TICK = 100;
const MAX_DISPATCH_PER_TICK = 50;

export interface ProfilerTickResult {
  seeded: number;
  dispatched: number;
  deferred: number;
  /** Due users held back because they're mid date-negotiation (not `scheduled`). */
  blocked: number;
}

export async function profilerTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<ProfilerTickResult> {
  const result: ProfilerTickResult = { seeded: 0, dispatched: 0, deferred: 0, blocked: 0 };

  // 1. Lazy seed — never-armed users. First batch at the next window (we don't
  // blast existing users immediately). New completions get the precise
  // now+entry-delay timing from the finalize hook instead.
  const unseeded = await prisma.profile.findMany({
    where: {
      profilerStartedAt: null,
      user: {
        status: "active",
        onboardingStep: "completed",
        telegramId: { gt: 0 },
        gender: { not: null },
      },
    },
    select: { userId: true, timeZone: true },
    take: MAX_SEED_PER_TICK,
  });
  for (const p of unseeded) {
    await prisma.profile.update({
      where: { userId: p.userId },
      data: {
        profilerStartedAt: now,
        profilerNextAt: nextWindowAt(now, resolveZone(p.timeZone)),
      },
    });
    result.seeded++;
  }

  // 2. Dispatch due batches. `profilerActiveQuestionId: null` ensures we never
  // double-fire into a batch that's mid-flight awaiting a reply.
  const due = await prisma.profile.findMany({
    where: {
      profilerNextAt: { lte: now },
      profilerActiveQuestionId: null,
      user: {
        status: "active",
        onboardingStep: "completed",
        telegramId: { gt: 0 },
        gender: { not: null },
      },
    },
    select: { userId: true, timeZone: true },
    take: MAX_DISPATCH_PER_TICK,
  });

  for (const p of due) {
    // Defer out of the user's local quiet hours (window times are safe, but a
    // finalize-seeded first question or DST edge could land in [23,09)).
    if (isQuietHourLocal(now, p.timeZone)) {
      await prisma.profile.update({
        where: { userId: p.userId },
        data: { profilerNextAt: nextWindowAt(now, resolveZone(p.timeZone)) },
      });
      result.deferred++;
      continue;
    }
    // Don't interrupt an in-progress date negotiation (pitch decision, calendar
    // scheduling, or venue selection) with icebreaker questions — defer to the
    // next local window. A `scheduled` match does NOT block: that waiting window
    // is a fine moment to ask (PRODUCT_SPEC §Phase 1b).
    if (await hasActiveDatePlanning(p.userId)) {
      await prisma.profile.update({
        where: { userId: p.userId },
        data: { profilerNextAt: nextWindowAt(now, resolveZone(p.timeZone)) },
      });
      result.blocked++;
      continue;
    }
    try {
      await startProfilerBatch(api, p.userId, now);
      result.dispatched++;
    } catch (err) {
      console.error(`[profiler] batch start failed for ${p.userId}:`, err);
    }
  }

  return result;
}
