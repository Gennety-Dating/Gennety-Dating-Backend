/**
 * D10 — pool exhaustion (DAILY_MATCHING_IMPLEMENTATION_PLAN.md §D10).
 *
 * Before this existed, a user for whom the candidate pool was genuinely
 * empty (e.g. a man in a city with zero eligible women) fell into an
 * indefinite famine loop: the same escalating-tier DM, forever, with no
 * signal that distinguished "temporarily unlucky this batch" from "there is
 * currently nobody for you at all". `FAMINE_PAUSE_AFTER_DAYS` (28) days of
 * that is treated as a real, distinct state: matching is paused (the
 * existing `active → paused` machinery — see `account-status-transitions.ts`
 * — so the user quietly leaves every future batch's eligibility query
 * instead of continuing to occupy a slot nothing can fill), the user is told
 * the truth instead of getting another famine tier DM, and the pause
 * reverses itself automatically the moment a candidate actually exists,
 * without waiting for the user to notice and tap Resume.
 *
 * `Profile.starvationPausedAt` is the marker that makes this distinguishable
 * from an ordinary user-initiated pause (see the schema comment) — only a
 * row with that marker set is ever touched by `autoResumeStarvedUsers`.
 */

import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { findCandidatesFor } from "./match-engine.js";
import { transitionAccountStatus } from "./account-status-transitions.js";

export interface AutoResumeResult {
  checked: number;
  resumed: number;
  errors: Array<{ userId: string; error: string }>;
}

/**
 * Sweep every system-paused user and resume the ones a candidate now exists
 * for. Called from the same famine-notice cron tick, after the notice loop
 * — no dedicated cron registration needed (mirrors `autoUnsuspendElapsed`'s
 * shape: a periodic scan reversing a status this same subsystem set).
 */
export async function autoResumeStarvedUsers(
  api: Api<RawApi>,
): Promise<AutoResumeResult> {
  const paused = await prisma.user.findMany({
    where: {
      status: "paused",
      profile: { starvationPausedAt: { not: null } },
    },
    select: { id: true, telegramId: true, language: true },
  });

  let resumed = 0;
  const errors: AutoResumeResult["errors"] = [];

  for (const user of paused) {
    try {
      const candidates = await findCandidatesFor(user.id, 1, {
        allowPausedSeeker: true,
      });
      if (candidates.length === 0) continue;

      // CAS — races safely against a manual resume, a moderation action, or
      // another overlapping tick. Only the side that actually wins the
      // transition sends the DM.
      const result = await transitionAccountStatus({ id: user.id }, "resume");
      if (result.kind !== "changed") continue;

      resumed++;
      if (user.telegramId > 0n) {
        const lang: Language = (user.language as Language) ?? "en";
        try {
          await api.sendMessage(
            Number(user.telegramId),
            t(lang, "poolExhaustedResumeNotice"),
          );
        } catch (err) {
          console.warn(
            `[pool-exhaustion] resume DM failed for userId=${user.id}:`,
            (err as Error).message,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ userId: user.id, error: message });
      console.error(
        `[pool-exhaustion] auto-resume check failed for userId=${user.id}:`,
        message,
      );
    }
  }

  if (paused.length > 0) {
    console.log(
      `[pool-exhaustion] checked=${paused.length} resumed=${resumed} errors=${errors.length}`,
    );
  }

  return { checked: paused.length, resumed, errors };
}
