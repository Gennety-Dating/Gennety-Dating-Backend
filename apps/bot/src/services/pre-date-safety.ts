import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, escapeMd, type Language, PRE_DATE_SAFETY_HOURS } from "@gennety/shared";
import { sendPushToUser } from "./push.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";

/**
 * Pre-date safety note — sent 1.5h before `agreedTime` to the female user
 * in a mutually confirmed pair (PRODUCT_SPEC §Phase 4).
 *
 * Triggers: `Match.status === "scheduled"` (both users accepted + time locked)
 *           AND `agreedTime` falls within the next `PRE_DATE_SAFETY_HOURS`.
 * Recipients: only users where `User.gender === "female"`.
 * Idempotent via `Match.safetyNoteSentAt`.
 *
 * **The app rail did not exist until §5.4.** This module carried a comment
 * saying mobile users "get safety briefs via push, not Telegram DM" while
 * filtering recipients on `telegramId > 0n` and sending nothing else — the
 * same shape of lie `pitch.ts` told about the drop for six weeks, and the
 * ninth instance of one mechanic existing on one surface only. Two separate
 * defects sat inside that one filter, and the second is worse than the first:
 * a woman on the app got no brief at all, and a woman who signed in through
 * Telegram (a REAL positive id on an account the bot cannot message — §1.1)
 * got nothing either, on a rail that reported success. Reachability is
 * `platform`, per side, and both rails are attempted.
 *
 * The push is `time-sensitive` (`TIME_SENSITIVE_PUSH_TYPES`): it is one of two
 * notifications in the product with a claim on someone's Focus, because it
 * arrives ninety minutes before they walk out to meet a stranger and is
 * useless afterwards.
 */

/** Matches the client's `PushPayload` type strings. */
export const SAFETY_BRIEF_PUSH_TYPE = "safety.brief";

export interface PreDateSafetyResult {
  sent: number;
}

export async function runPreDateSafetyTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<PreDateSafetyResult> {
  const windowEnd = new Date(now.getTime() + PRE_DATE_SAFETY_HOURS * 60 * 60 * 1000);

  const upcoming = await prisma.match.findMany({
    where: {
      status: "scheduled",
      agreedTime: { gt: now, lte: windowEnd },
      safetyNoteSentAt: null,
      venueName: { not: null },
    },
    select: {
      id: true,
      venueName: true,
      userA: {
        select: {
          id: true,
          telegramId: true,
          platform: true,
          gender: true,
          language: true,
        },
      },
      userB: {
        select: {
          id: true,
          telegramId: true,
          platform: true,
          gender: true,
          language: true,
        },
      },
    },
  });

  const result: PreDateSafetyResult = { sent: 0 };

  for (const match of upcoming) {
    const claim = await prisma.match.updateMany({
      where: { id: match.id, status: "scheduled", safetyNoteSentAt: null },
      data: { safetyNoteSentAt: now },
    });
    if (claim.count === 0) continue;

    // Gender selects the recipient; reachability decides which rail (or both)
    // she is told on. The two are separate questions, and collapsing them into
    // one filter is exactly what dropped every app-side woman before §5.4.
    const recipients = [match.userA, match.userB].filter((u) => u.gender === "female");

    if (recipients.length === 0) {
      continue;
    }

    const venue = escapeMd(match.venueName ?? "");

    // Per-leg .catch so one blocked / unreachable user doesn't abort the
    // batch and trigger duplicate sends on the next tick.
    await Promise.all(
      recipients.flatMap((u) => {
        const lang = (u.language ?? "en") as Language;
        const legs: Promise<unknown>[] = [];

        if (telegramReachable(u)) {
          legs.push(
            api
              .sendMessage(
                Number(u.telegramId),
                t(lang, "safetyNoteFemale", { location_name: venue }),
                { parse_mode: "Markdown" },
              )
              .catch((err: unknown) => {
                console.warn(
                  `[pre-date-safety] send failed for ${u.telegramId}:`,
                  err instanceof Error ? err.message : err,
                );
              }),
          );
        }

        if (pushReachable(u)) {
          legs.push(
            sendPushToUser(u.id, {
              title: t(lang, "safetyBriefPushTitle"),
              body: t(lang, "safetyBriefPushBody"),
              data: { type: SAFETY_BRIEF_PUSH_TYPE, matchId: match.id },
            }).catch((err: unknown) => {
              console.warn(
                `[pre-date-safety] push failed for ${u.id}:`,
                err instanceof Error ? err.message : err,
              );
              return false;
            }),
          );
        }

        return legs;
      }),
    );

    result.sent++;
  }

  return result;
}
