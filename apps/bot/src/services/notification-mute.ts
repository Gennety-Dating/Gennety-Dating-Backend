import { prisma } from "@gennety/db";

/**
 * «Только мои свидания» — the per-type mute (agent concept phase 4 item 6,
 * founder 2026-11-26). `User.notifyOnlyDates = true` silences everything
 * Gennety sends on its own that is not about the person's own matches and
 * dates. One list here, so a new proactive sender has one place to say
 * which side it is on.
 *
 * Muted (each sender checks it):
 * - `profiler` — Telegram Profiler batches (`workers/profiler.ts`);
 * - `re_engagement` — the onboarding chain (`workers/re-engagement.ts`);
 * - `announcement` — announcement pushes; the inbox row is still written;
 * - `waiting_notice` — «no pair this time» notices (`no-match-notifier.ts`);
 * - `rematch_offer` — pushed Rematch offers (a tap on the entry still opens it);
 * - `wishlist_session` — the wishlist session push;
 * - `idea_reminder` — an idea reminder not tied to a planned match;
 * - `referral_reward` — «your friend joined» (the tickets are still credited);
 * - `place_tip` — the proactive place tip (`place-tips.ts`, decision 2026-11-26).
 *
 * Never muted: pitches and match nudges, scheduling, venue and ticket flow,
 * the date lifecycle (T-5h, T-90m, Date Terminal, T+24h, the Morning After),
 * the proxy chat, cancellations and safety, verification, refunds and
 * billing notices, an idea reminder for a planned date, the personal
 * reminders the person asked for, and the agent's answers to their own turn.
 */
export const ONLY_MY_DATES_MUTED_KINDS = [
  "profiler",
  "re_engagement",
  "announcement",
  "waiting_notice",
  "rematch_offer",
  "wishlist_session",
  "idea_reminder",
  "referral_reward",
  "place_tip",
] as const;
export type OnlyMyDatesMutedKind = (typeof ONLY_MY_DATES_MUTED_KINDS)[number];

/** `user` where-fragment for a sender that reads its audience in one query. */
export const NOT_ONLY_MY_DATES = { notifyOnlyDates: false } as const;

/**
 * Whether this person muted `kind` with «only my dates». The kind is not read
 * — every listed kind is muted together — but naming it at the call site keeps
 * the list above honest and grep-able.
 */
export async function mutedByOnlyMyDates(
  userId: string,
  _kind: OnlyMyDatesMutedKind,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notifyOnlyDates: true },
  });
  return user?.notifyOnlyDates === true;
}
