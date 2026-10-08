import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  MORNING_AFTER_HOUR,
  MORNING_AFTER_LATEST_HOUR,
  MORNING_AFTER_MAX_AGE_MS,
  MORNING_AFTER_MIN_GAP_MS,
  MUTUAL_OFFER_VISIBLE_MS,
  afterDateT,
  isMorningAfterAnswer,
  type Language,
  type MorningAfterAnswer,
} from "@gennety/shared";
import { env } from "../config.js";
import { sendPushToUser } from "./push.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import { resolveZone, wallToUtc, zonedParts } from "./profiler-schedule.js";

/**
 * «The Morning After» (decision journal 2026-10-08, the founder's brief §3).
 *
 * The emotional peak is the first 24 hours after a first date, so the product
 * asks then — not a week later, and not by guessing from GPS: a pair can share
 * a campus, an office or a concert without knowing it, and background location
 * costs battery and an iOS "always" prompt. The date's time is already known,
 * so no tracking is needed at all (Hinge's «We Met» made the same call).
 *
 * The morning after, at 11:00 in the pair's city, each side is asked
 * separately: «Как всё прошло вчера с [Имя]?» with two buttons — 🔥 "great,
 * want to meet again" / 🤷 "didn't click".
 *
 * **Double-blind.** Nobody ever learns the other's answer. Only when BOTH say
 * `great` is `mutualInterestAt` stamped — exactly once, by compare-and-set —
 * and then both are told it is mutual and shown the offer (the partner's
 * favourite flowers and the Date Wishlist cheat sheet, `after-date-offer.ts`).
 * A `pass` is never revealed, not even as "your match didn't answer": the
 * `great` side simply hears nothing, the way the decision invariant treats a
 * decline.
 *
 * **Not the feedback form.** The T+24h form (chemistry 1–10, venue fit, text)
 * stays and still feeds matching; it just no longer asks "second date?" of
 * someone who already answered here (`post-date-feedback.ts`). The Live
 * Activity's one-tap `vibe_check` at T+2h is a third, separate instrument
 * (`date-vibe.ts`) and is not read here.
 *
 * Off unless `MORNING_AFTER_ENABLED`.
 */

/** The first local `MORNING_AFTER_HOUR`:00 at least `MORNING_AFTER_MIN_GAP_MS` after the date. */
export function morningAfterDueAt(agreedTime: Date, timeZone: string | null | undefined): Date {
  const zone = resolveZone(timeZone);
  const earliest = new Date(agreedTime.getTime() + MORNING_AFTER_MIN_GAP_MS);
  const p = zonedParts(earliest, zone);
  const sameDay = wallToUtc(p.year, p.month, p.day, MORNING_AFTER_HOUR, 0, zone);
  if (sameDay.getTime() >= earliest.getTime()) return sameDay;
  // Next calendar day: build it from the UTC calendar so month/year roll over.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return wallToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    MORNING_AFTER_HOUR,
    0,
    zone,
  );
}

/**
 * Whether the check for a date at `agreedTime` may go out at `now`: from the
 * due 11:00 until the latest hour that same morning, and never for a date
 * older than `MORNING_AFTER_MAX_AGE_MS`. A missed window is not retried the
 * day after — the moment is the point.
 */
export function isMorningAfterWindow(
  now: Date,
  agreedTime: Date,
  timeZone: string | null | undefined,
): boolean {
  if (now.getTime() - agreedTime.getTime() > MORNING_AFTER_MAX_AGE_MS) return false;
  const due = morningAfterDueAt(agreedTime, timeZone);
  const closes = due.getTime() + (MORNING_AFTER_LATEST_HOUR - MORNING_AFTER_HOUR) * 60 * 60 * 1000;
  return now.getTime() >= due.getTime() && now.getTime() < closes;
}

/**
 * Telegram inline keyboard for the check. Callback data: `ma:g:<id>` / `ma:p:<id>`.
 * The 🔥 / 🤷 marks belong to the bot's buttons, not to the copy: the app draws
 * its own marks next to the same labels.
 */
export function morningAfterKeyboard(matchId: string, lang: Language) {
  return {
    inline_keyboard: [
      [{ text: `🔥 ${afterDateT(lang, "morningAfterGreat")}`, callback_data: `ma:g:${matchId}` }],
      [{ text: `🤷 ${afterDateT(lang, "morningAfterPass")}`, callback_data: `ma:p:${matchId}` }],
    ],
  };
}

/** The check's text: the question plus the double-blind promise. */
export function morningAfterText(lang: Language, partnerName: string): string {
  return [
    afterDateT(lang, "morningAfterQuestion", { name: partnerName }),
    afterDateT(lang, "morningAfterBlind", { name: partnerName }),
  ].join("\n\n");
}

const participantSelect = {
  id: true,
  telegramId: true,
  platform: true,
  language: true,
  firstName: true,
  gender: true,
  profile: { select: { timeZone: true } },
} as const;

/**
 * Step of the date-lifecycle tick: send the check to every pair whose morning
 * has come. Claimed per match on `morningAfterSentAt` (one-shot), then each
 * side is asked on its own rails — the Telegram DM names the partner, the push
 * does not (the lock screen is public).
 *
 * Returns how many pairs were asked.
 */
export async function runMorningAfterTick(
  api: Api<RawApi> | null,
  now: Date = new Date(),
): Promise<number> {
  if (!env.MORNING_AFTER_ENABLED) return 0;
  const candidates = await prisma.match.findMany({
    where: {
      status: { in: ["scheduled", "completed"] },
      morningAfterSentAt: null,
      agreedTime: {
        gte: new Date(now.getTime() - MORNING_AFTER_MAX_AGE_MS),
        lte: new Date(now.getTime() - MORNING_AFTER_MIN_GAP_MS),
      },
    },
    select: {
      id: true,
      agreedTime: true,
      dateAttendedA: true,
      dateAttendedB: true,
      userA: { select: participantSelect },
      userB: { select: participantSelect },
    },
  });

  let sent = 0;
  for (const match of candidates) {
    if (!match.agreedTime) continue;
    // Somebody already said the date did not happen: asking "how was it" of
    // either side reads as an agent with no memory.
    if (match.dateAttendedA === false || match.dateAttendedB === false) continue;
    // The pair shares a city, so one zone is the pair's morning.
    const zone = match.userA.profile?.timeZone ?? match.userB.profile?.timeZone ?? null;
    if (!isMorningAfterWindow(now, match.agreedTime, zone)) continue;

    const claim = await prisma.match.updateMany({
      where: { id: match.id, morningAfterSentAt: null },
      data: { morningAfterSentAt: now },
    });
    if (claim.count === 0) continue;

    const sends: Array<Promise<unknown>> = [];
    for (const [me, partner] of [
      [match.userA, match.userB],
      [match.userB, match.userA],
    ] as const) {
      const lang = (me.language ?? "en") as Language;
      if (api && telegramReachable(me)) {
        sends.push(
          api
            .sendMessage(
              Number(me.telegramId),
              morningAfterText(lang, partner.firstName ?? ""),
              { reply_markup: morningAfterKeyboard(match.id, lang) },
            )
            .catch((err: unknown) =>
              console.warn(
                `[morning-after] DM failed for ${me.id}:`,
                err instanceof Error ? err.message : err,
              ),
            ),
        );
      }
      if (pushReachable(me)) {
        sends.push(
          sendPushToUser(me.id, {
            title: afterDateT(lang, "morningAfterPushTitle"),
            body: afterDateT(lang, "morningAfterPushBody"),
            data: { type: "date.morning_after", matchId: match.id },
            collapseId: `morning-after-${match.id}`,
          }).catch((err: unknown) =>
            console.warn(
              `[morning-after] push failed for ${me.id}:`,
              err instanceof Error ? err.message : err,
            ),
          ),
        );
      }
    }
    await Promise.all(sends);
    sent++;
  }
  return sent;
}

export type MorningAfterRefusal = "not-found" | "not-asked" | "bad-answer" | "already-answered";

export type MorningAfterResult =
  | { ok: true; answer: MorningAfterAnswer; mutual: boolean; mutualJustNow: boolean }
  | { ok: false; error: MorningAfterRefusal };

/**
 * Record one side's tap. One-shot: the same answer again is an idempotent
 * success (a retried request, a second device); a different one is refused —
 * the other side may already have been told it is mutual.
 *
 * `mutualJustNow` is true for exactly one call per match — the one whose
 * compare-and-set stamped `mutualInterestAt` — and that caller announces it.
 */
export async function recordMorningAfter(input: {
  matchId: string;
  userId: string;
  answer: unknown;
  now?: Date;
}): Promise<MorningAfterResult> {
  const now = input.now ?? new Date();
  if (!isMorningAfterAnswer(input.answer)) return { ok: false, error: "bad-answer" };
  const answer = input.answer;

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      morningAfterSentAt: true,
      morningAfterA: true,
      morningAfterB: true,
      mutualInterestAt: true,
    },
  });
  // 404 for a non-participant too: the route must not reveal which ids exist.
  if (!match || (match.userAId !== input.userId && match.userBId !== input.userId)) {
    return { ok: false, error: "not-found" };
  }
  if (!match.morningAfterSentAt) return { ok: false, error: "not-asked" };

  const isA = match.userAId === input.userId;
  const own = isA ? match.morningAfterA : match.morningAfterB;
  if (own) {
    if (own !== answer) return { ok: false, error: "already-answered" };
    return { ok: true, answer, mutual: Boolean(match.mutualInterestAt), mutualJustNow: false };
  }

  const claim = await prisma.match.updateMany({
    where: isA
      ? { id: match.id, morningAfterA: null }
      : { id: match.id, morningAfterB: null },
    data: isA
      ? { morningAfterA: answer, morningAfterAtA: now }
      : { morningAfterB: answer, morningAfterAtB: now },
  });
  if (claim.count === 0) {
    // A parallel request wrote first; report whatever it wrote.
    return recordMorningAfter({ ...input, now });
  }

  if (answer !== "great") return { ok: true, answer, mutual: false, mutualJustNow: false };

  // Read the other side AFTER our write: whichever of two simultaneous "great"
  // taps reads second sees both, and the CAS below lets exactly one announce.
  const after = await prisma.match.findUnique({
    where: { id: match.id },
    select: { morningAfterA: true, morningAfterB: true, mutualInterestAt: true },
  });
  if (after?.morningAfterA !== "great" || after?.morningAfterB !== "great") {
    return { ok: true, answer, mutual: false, mutualJustNow: false };
  }
  const stamp = await prisma.match.updateMany({
    where: { id: match.id, mutualInterestAt: null },
    data: { mutualInterestAt: now },
  });
  return { ok: true, answer, mutual: true, mutualJustNow: stamp.count === 1 };
}

/**
 * Tell both sides it is mutual — push without names, Telegram DM with the
 * offer (`sendMutualOfferDm`, injected so this module does not import the
 * Telegram offer rendering). Best effort per side.
 */
export async function announceMutual(
  api: Api<RawApi> | null,
  matchId: string,
  sendOfferDm: (api: Api<RawApi>, matchId: string, viewerId: string) => Promise<void>,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userA: { select: participantSelect },
      userB: { select: participantSelect },
    },
  });
  if (!match) return;
  await Promise.all(
    [match.userA, match.userB].map(async (me) => {
      const lang = (me.language ?? "en") as Language;
      if (api && telegramReachable(me)) {
        await sendOfferDm(api, matchId, me.id).catch((err: unknown) =>
          console.warn(
            `[morning-after] mutual DM failed for ${me.id}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
      if (pushReachable(me)) {
        await sendPushToUser(me.id, {
          title: afterDateT(lang, "mutualPushTitle"),
          body: afterDateT(lang, "mutualPushBody"),
          data: { type: "date.mutual", matchId },
          collapseId: `mutual-${matchId}`,
        }).catch(() => false);
      }
    }),
  );
}

export interface PendingMorningAfter {
  matchId: string;
  partnerFirstName: string | null;
  /** Storage path of the partner's first photo — the route signs it. */
  partnerPhotoPath: string | null;
  venueName: string | null;
  agreedTime: Date;
}

/**
 * The check this user still owes, for the app's «Сегодня»: asked, not yet
 * answered by them, and still the morning it was asked (until the latest
 * hour's day is over is too long — the window closes `MORNING_AFTER_MAX_AGE_MS`
 * after the date).
 */
export async function pendingMorningAfterFor(
  userId: string,
  now: Date = new Date(),
): Promise<PendingMorningAfter | null> {
  if (!env.MORNING_AFTER_ENABLED) return null;
  const since = new Date(now.getTime() - MORNING_AFTER_MAX_AGE_MS);
  const match = await prisma.match.findFirst({
    where: {
      morningAfterSentAt: { not: null },
      agreedTime: { gte: since },
      OR: [
        { userAId: userId, morningAfterA: null },
        { userBId: userId, morningAfterB: null },
      ],
    },
    orderBy: { agreedTime: "desc" },
    select: {
      id: true,
      agreedTime: true,
      venueName: true,
      userAId: true,
      userA: { select: { firstName: true, profile: { select: { photos: true } } } },
      userB: { select: { firstName: true, profile: { select: { photos: true } } } },
    },
  });
  if (!match || !match.agreedTime) return null;
  const partner = match.userAId === userId ? match.userB : match.userA;
  return {
    matchId: match.id,
    partnerFirstName: partner.firstName ?? null,
    partnerPhotoPath: partner.profile?.photos?.[0] ?? null,
    venueName: match.venueName ?? null,
    agreedTime: match.agreedTime,
  };
}

/** Mutual matches whose offer is still shown on «Сегодня», newest first. */
export async function recentMutualMatchIds(
  userId: string,
  now: Date = new Date(),
): Promise<string[]> {
  if (!env.MORNING_AFTER_ENABLED) return [];
  const rows = await prisma.match.findMany({
    where: {
      mutualInterestAt: { gte: new Date(now.getTime() - MUTUAL_OFFER_VISIBLE_MS) },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { mutualInterestAt: "desc" },
    select: { id: true },
    take: 3,
  });
  return rows.map((row) => row.id);
}

/**
 * The person's own morning answer on a match, if any — read by the feedback
 * form so it does not ask "second date?" twice.
 */
export function ownMorningAnswer(
  match: { userAId: string; morningAfterA: string | null; morningAfterB: string | null },
  userId: string,
): MorningAfterAnswer | null {
  const value = match.userAId === userId ? match.morningAfterA : match.morningAfterB;
  return isMorningAfterAnswer(value) ? value : null;
}
