import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, escapeMd, type Language, PRE_DATE_SAFETY_HOURS } from "@gennety/shared";

/**
 * Pre-date safety note — sent 1h before `agreedTime` to the female user
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
    const recipients = [match.userA, match.userB].filter((u) => u.gender === "female");

    if (recipients.length === 0) {
      await prisma.match.update({
        where: { id: match.id },
        data: { safetyNoteSentAt: now },
      });
      continue;
    }

    const venue = escapeMd(match.venueName ?? "");

    await Promise.all(
      recipients.map((u) => {
        const lang = (u.language ?? "en") as Language;
        return api.sendMessage(
          Number(u.telegramId),
          t(lang, "safetyNoteFemale", { location_name: venue }),
          { parse_mode: "Markdown" },
        );
      }),
    );

    await prisma.match.update({
      where: { id: match.id },
      data: { safetyNoteSentAt: now },
    });

    result.sent++;
  }

  return result;
}
