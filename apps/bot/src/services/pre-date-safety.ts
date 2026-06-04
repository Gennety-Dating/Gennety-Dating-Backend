import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, escapeMd, type Language, PRE_DATE_SAFETY_HOURS } from "@gennety/shared";

/**
 * Pre-date safety note — sent 1.5h before `agreedTime` to the female user
 * in a mutually confirmed pair (PRODUCT_SPEC §Phase 4).
 *
 * Triggers: `Match.status === "scheduled"` (both users accepted + time locked)
 *           AND `agreedTime` falls within the next `PRE_DATE_SAFETY_HOURS`.
 * Recipients: only users where `User.gender === "female"`.
 * Idempotent via `Match.safetyNoteSentAt`.
 */

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
      userA: { select: { telegramId: true, gender: true, language: true } },
      userB: { select: { telegramId: true, gender: true, language: true } },
    },
  });

  const result: PreDateSafetyResult = { sent: 0 };

  for (const match of upcoming) {
    // Skip mobile-first synthetic users (telegramId <= 0n) — they get safety
    // briefs via push, not Telegram DM. Filtering at the recipient level
    // means an F-mobile + F-telegram pair still notifies the Telegram side.
    const recipients = [match.userA, match.userB].filter(
      (u) => u.gender === "female" && u.telegramId > 0n,
    );

    if (recipients.length === 0) {
      await prisma.match.update({
        where: { id: match.id },
        data: { safetyNoteSentAt: now },
      });
      continue;
    }

    const venue = escapeMd(match.venueName ?? "");

    // Per-leg .catch so one blocked / unreachable user doesn't abort the
    // batch and trigger duplicate sends on the next tick.
    await Promise.all(
      recipients.map((u) => {
        const lang = (u.language ?? "en") as Language;
        return api
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
          });
      }),
    );

    // Stamp safetyNoteSentAt unconditionally — even if every leg failed.
    // Otherwise the next tick re-fans the batch and survivors get duplicates.
    // A persistent send failure is a per-user issue (bot blocked, etc.) not
    // a reason to keep retrying the whole match.
    await prisma.match.update({
      where: { id: match.id },
      data: { safetyNoteSentAt: now },
    });

    result.sent++;
  }

  return result;
}
