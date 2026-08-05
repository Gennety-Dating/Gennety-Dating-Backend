import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { CADENCE, t, type Language } from "@gennety/shared";
import { applySilentIgnorePenalty } from "../utils/elo-calculator.js";
import { boostAcceptedSidePriority } from "./match-decision-shared.js";
import { refundMatchTickets, ticketRefundNoticeKey } from "./ticket-refund.js";
import { sendPushToUser } from "./push.js";

/**
 * Stall handling for the two open-ended planning phases (PRODUCT_SPEC §3.5c).
 *
 * The 24h TTL only covers the pitch decision. Once both sides accept, the
 * scheduling and venue steps had NO deadline of any kind: a partner who went
 * quiet left the other person waiting forever, with no chat to ask through and
 * no way to cancel. The real cost is not the silence — it is that both sides
 * occupy a live match, and the single-live-match invariant keeps them out of
 * every weekly batch until it resolves. One ghost therefore cost the other
 * person an entire cycle.
 *
 * So the chain is: two gentle nudges (6h/12h, in the nudge worker) → a
 * "still in?" check-in with an explicit answer at 24h → cancellation at 48h.
 * Cancellation frees BOTH sides for the next drop, which is the whole point.
 *
 * Penalties are deliberately asymmetric, because we want the red button pressed
 * rather than ignored: an honest "plans changed" costs nothing at all, while
 * running the clock out is treated as a silent ignore (forgive-once, then the
 * same Elo hit as a decline). The waiting side is compensated with next-batch
 * priority in both cases.
 *
 * Telegram-only in v1: the check-in is an inline-keyboard question, so a
 * mobile-only participant could never answer it. Rather than auto-cancelling on
 * someone we never actually asked, a stall involving an unreachable side is
 * simply left alone (see `stallReachableFor`).
 */

/**
 * Venue/stall timing, sourced from the active `CADENCE` profile. Weekly
 * values are unchanged from the old hardcoded constants (6h/12h venue nudges,
 * 24h check-in, 48h timeout); daily halves the check-in/timeout (12h/24h) so
 * one ghost doesn't cost a partner two full drop cycles — see the
 * implementation plan's Phase 3 note.
 */
/** First venue-phase reminder — mirrors the scheduling phase's first nudge. */
export const VENUE_NUDGE1_MS = CADENCE.venueNudgeOffsetsMs[0];
/** Second venue-phase reminder — mirrors the scheduling phase's second nudge. */
export const VENUE_NUDGE2_MS = CADENCE.venueNudgeOffsetsMs[1];
/** When the "still in?" question goes out to a side that still owes an action. */
export const STALL_CHECK_IN_MS = CADENCE.stallCheckInMs;
/**
 * When an unanswered stall cancels the match — comfortably before the next
 * drop, so the freed users make the very next batch regardless of cadence.
 */
export const STALL_TIMEOUT_MS = CADENCE.stallTimeoutMs;

export type StallPhase = "scheduling" | "venue";
export type MatchSide = "A" | "B";
/** The live status each phase runs in — also what its cancellation CAS asserts. */
export const STALL_PHASE_STATUS: Record<StallPhase, "negotiating" | "negotiating_venue"> = {
  scheduling: "negotiating",
  venue: "negotiating_venue",
};

/**
 * The columns every stall decision reads. Exported so the worker's query and
 * these predicates can never drift apart on what they need.
 */
export const STALL_MATCH_SELECT = {
  id: true,
  status: true,
  userAId: true,
  userBId: true,
  dispatchedAt: true,
  schedulingOpenedAt: true,
  venuePromptAskedAt: true,
  proposedTimes: true,
  availableTimesA: true,
  availableTimesB: true,
  vibeTextA: true,
  vibeLatA: true,
  vibeLngA: true,
  vibeTextB: true,
  vibeLatB: true,
  vibeLngB: true,
  stallCheckInSentAtA: true,
  stallCheckInSentAtB: true,
  stallConfirmedAtA: true,
  stallConfirmedAtB: true,
  venueNudge1SentAt: true,
  venueNudge2SentAt: true,
  userA: { select: { id: true, telegramId: true, language: true, firstName: true, theme: true } },
  userB: { select: { id: true, telegramId: true, language: true, firstName: true, theme: true } },
} as const;

/** Minimal shape the pure predicates below operate on. */
export interface StallMatchRow {
  status: string;
  dispatchedAt: Date | null;
  schedulingOpenedAt: Date | null;
  venuePromptAskedAt: Date | null;
  proposedTimes: Date[];
  availableTimesA: Date[];
  availableTimesB: Date[];
  vibeTextA: string | null;
  vibeLatA: number | null;
  vibeLngA: number | null;
  vibeTextB: string | null;
  vibeLatB: number | null;
  vibeLngB: number | null;
  stallConfirmedAtA: Date | null;
  stallConfirmedAtB: Date | null;
}

/**
 * Which open-ended phase this row is in, or null when it is in neither.
 *
 * `negotiating` covers TWO things: the Date Ticket gate and the Calendar. The
 * gate has its own deadline, refund policy and expiry worker, so a pair still
 * inside it is not stalled — it is waiting on money, which someone else owns.
 * `proposedTimes` is the honest discriminator: `startScheduling` writes it when
 * (and only when) the Calendar actually opens, whether the gate ran or not.
 * `ticketStatus` cannot be used for this — it defaults to "pending" even with
 * the ticket feature switched off entirely.
 */
export function stallPhaseOf(row: Pick<StallMatchRow, "status" | "proposedTimes">): StallPhase | null {
  if (row.status === "negotiating_venue") return "venue";
  if (row.status === "negotiating" && row.proposedTimes.length > 0) return "scheduling";
  return null;
}

/**
 * When the current phase opened — everything downstream counts from here.
 *
 * The scheduling phase prefers `schedulingOpenedAt` and falls back to
 * `dispatchedAt` for rows that predate that column: the fallback reproduces the
 * old (slightly early) cadence, which is much better than a null anchor
 * silently exempting in-flight matches from the whole chain.
 */
export function stallAnchorAt(row: StallMatchRow): Date | null {
  const phase = stallPhaseOf(row);
  if (phase === "venue") return row.venuePromptAskedAt;
  if (phase === "scheduling") return row.schedulingOpenedAt ?? row.dispatchedAt;
  return null;
}

/** Do two slot selections share at least one instant? */
function sharesASlot(mine: Date[], theirs: Date[]): boolean {
  const peerSet = new Set(theirs.map((d) => d.getTime()));
  return mine.some((d) => peerSet.has(d.getTime()));
}

/**
 * WHY this side owes the scheduling step something, or null when it doesn't.
 *
 * Two shapes, and they need different words:
 *   - `no-picks`   — never opened the calendar. "Pick a time."
 *   - `no-overlap` — both picked and nothing lines up. Telling this person to
 *                    "pick a time" is wrong; they did. Their move is to widen
 *                    the selection or take one of the partner's slots.
 *
 * `no-overlap` used to be neither: `sideOwesAction` only asked whether a side
 * had marked anything, so once BOTH had, nobody owed anything. No nudge, no
 * "still on?" check-in, and no 48h cancellation — the pair sat in a live match
 * indefinitely, excluded from every drop by the single-live-match rule, with a
 * shimmer telling both of them the time was being coordinated for them.
 */
export type SchedulingOwed = "no-picks" | "no-overlap";

export function schedulingOwedKind(row: StallMatchRow, side: MatchSide): SchedulingOwed | null {
  if (stallPhaseOf(row) !== "scheduling") return null;
  const mine = side === "A" ? row.availableTimesA : row.availableTimesB;
  const theirs = side === "A" ? row.availableTimesB : row.availableTimesA;
  if (mine.length === 0) return "no-picks";
  // I picked, they haven't opened the calendar yet: their move, not mine. (This
  // is the one calendar state that gets the §3.6b waiting shimmer.)
  if (theirs.length === 0) return null;
  // A shared slot auto-locks the date (`scheduler.ts`), so if the row is still
  // here there is none — and the next move belongs to both sides again.
  return sharesASlot(mine, theirs) ? null : "no-overlap";
}

/**
 * Does this side still owe the action its phase is waiting on?
 *
 * This is also the product's definition of "whose move is it", which is why the
 * §3.6b shimmer is its complement: a side that owes an action is told so
 * (reminder, then check-in), never shown a "we're working on it" status.
 */
export function sideOwesAction(row: StallMatchRow, side: MatchSide): boolean {
  const phase = stallPhaseOf(row);
  if (phase === "scheduling") {
    return schedulingOwedKind(row, side) !== null;
  }
  if (phase === "venue") {
    // Read off the legacy vibe columns on purpose: both write paths land there
    // — the chat handler directly, and the Venue Intent V2 Mini App mirrors a
    // confirmed intent onto them — so one check covers every rollout mode.
    return side === "A"
      ? !(row.vibeTextA && row.vibeLatA != null && row.vibeLngA != null)
      : !(row.vibeTextB && row.vibeLatB != null && row.vibeLngB != null);
  }
  return false;
}

/**
 * The clock this side's check-in and timeout count from: the phase anchor, or
 * its own 🟢 "still in" tap when that came later. Tapping green therefore buys
 * a fresh 48h rather than merely silencing one message.
 */
export function stallBaseFor(row: StallMatchRow, side: MatchSide): Date | null {
  const anchor = stallAnchorAt(row);
  if (!anchor) return null;
  const confirmed = side === "A" ? row.stallConfirmedAtA : row.stallConfirmedAtB;
  return confirmed && confirmed > anchor ? confirmed : anchor;
}

/** When this side's "still in?" question becomes due. */
export function stallCheckInDueAt(row: StallMatchRow, side: MatchSide): Date | null {
  const base = stallBaseFor(row, side);
  return base ? new Date(base.getTime() + STALL_CHECK_IN_MS) : null;
}

/**
 * The live "still in?" question for this side, or null — **scoped to the phase
 * currently running**.
 *
 * The stamps are per side but not per phase, and a match walks through both
 * (scheduling → venue). Without this scoping a side asked during scheduling —
 * who then answered by simply picking a time rather than tapping 🟢 — carried
 * its stamp into the venue phase, where `alreadyAsked` suppressed the question
 * forever while the 48h clock kept running. They would have been cancelled at
 * the venue step having never been asked at that step. Anything stamped before
 * the current phase opened belongs to the previous one and does not count; this
 * is the same rule `stallBaseFor` already applies to confirmations, so in-flight
 * rows self-heal with no reset write at the transition.
 */
export function stallCheckInAskedAt(
  row: StallMatchRow & { stallCheckInSentAtA: Date | null; stallCheckInSentAtB: Date | null },
  side: MatchSide,
): Date | null {
  const anchor = stallAnchorAt(row);
  if (!anchor) return null;
  const asked = side === "A" ? row.stallCheckInSentAtA : row.stallCheckInSentAtB;
  return asked && asked > anchor ? asked : null;
}

/**
 * Is a question on screen awaiting this side's answer? A confirmation at or
 * after the question means it was already answered — the same comparison the
 * callback handler uses, so the agent's context and the button can't disagree.
 */
export function stallCheckInPending(
  row: StallMatchRow & { stallCheckInSentAtA: Date | null; stallCheckInSentAtB: Date | null },
  side: MatchSide,
): boolean {
  const asked = stallCheckInAskedAt(row, side);
  if (!asked) return false;
  const confirmed = side === "A" ? row.stallConfirmedAtA : row.stallConfirmedAtB;
  return !(confirmed && confirmed >= asked);
}

/** When an unanswered stall on this side cancels the match. */
export function stallDeadlineAt(row: StallMatchRow, side: MatchSide): Date | null {
  const base = stallBaseFor(row, side);
  return base ? new Date(base.getTime() + STALL_TIMEOUT_MS) : null;
}

/**
 * Can we actually run the chain against this side? The question is an inline
 * keyboard in a Telegram chat; a mobile-only row (synthetic negative
 * `telegramId`) has no way to answer, and cancelling on someone we never asked
 * would be indefensible. Such a match is left untouched.
 */
export function stallReachableFor(telegramId: bigint): boolean {
  return telegramId > 0n;
}

// Deliberately four flat, non-nesting prefixes. `stall:cancel:` +
// `stall:cancel:yes:` would make the router's dispatch order load-bearing — the
// broader prefix silently swallows the narrower one — and that ordering trap has
// bitten this codebase before.
export const STALL_OK_PREFIX = "stall:ok:";
/** Red button / agent entry point → opens the confirmation card. Mutates nothing. */
export const STALL_ASK_CANCEL_PREFIX = "stall:no:";
/** The single irreversible step. */
export const STALL_CANCEL_CONFIRM_PREFIX = "stall:kill:";
export const STALL_CANCEL_BACK_PREFIX = "stall:back:";

/** The two-button "still in?" keyboard, native styles: green calm, red exit. */
export function buildStallCheckInKeyboard(matchId: string, lang: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "stallBtnStillOn"), `${STALL_OK_PREFIX}${matchId}`)
    .success()
    .row()
    .text(t(lang, "stallBtnPlansChanged"), `${STALL_ASK_CANCEL_PREFIX}${matchId}`);
}

/**
 * The red path's confirmation card. Shared by the check-in button and the
 * agent-surfaced entry point, so "cancel by text/voice" and "cancel by button"
 * land on exactly one irreversible step with one way back.
 */
export function buildStallCancelConfirmKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "stallBtnCancelBack"), `${STALL_CANCEL_BACK_PREFIX}${matchId}`)
    .success()
    .row()
    .text(t(lang, "stallBtnCancelConfirm"), `${STALL_CANCEL_CONFIRM_PREFIX}${matchId}`)
    .danger();
}

type StallParticipant = {
  id: string;
  telegramId: bigint;
  language: string | null;
  firstName: string | null;
};

function partnerName(user: StallParticipant, lang: Language): string {
  return user.firstName ?? t(lang, "stallPartnerFallbackName");
}

/**
 * Flip a live planning match to `cancelled`, exactly once.
 *
 * The compare-and-set on the CURRENT status is the ownership boundary: an
 * expiry tick, a freeze, or a moderation action landing in the same moment wins
 * or loses cleanly, and only the winner applies side effects.
 */
async function claimCancellation(
  matchId: string,
  phase: StallPhase,
  cancelledBy: string | null,
): Promise<boolean> {
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: STALL_PHASE_STATUS[phase] },
    data: { status: "cancelled", ...(cancelledBy ? { emergencyCancelledBy: cancelledBy } : {}) },
  });
  return claim.count > 0;
}

export interface StallCancelResult {
  cancelled: boolean;
  /** Sides that were still owing an action when the clock ran out. */
  ghostUserIds: string[];
  /** Sides that had done their part and were left waiting. */
  waitingUserIds: string[];
}

/**
 * The 48h outcome: cancel, then settle up.
 *
 * Ghosts take the silent-ignore treatment (forgive-once, then the decline-grade
 * Elo hit) — the same mechanic the pitch stage already uses, so ghosting is
 * priced identically wherever it happens. Anyone who had done their part gets
 * next-batch priority and an honest explanation of what happened. When BOTH
 * sides went quiet nobody is owed compensation, and both simply hear that the
 * match lapsed.
 */
export async function cancelStalledMatch(
  api: Api<RawApi>,
  matchId: string,
  now: Date = new Date(),
): Promise<StallCancelResult> {
  const empty: StallCancelResult = { cancelled: false, ghostUserIds: [], waitingUserIds: [] };

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: STALL_MATCH_SELECT,
  });
  if (!match) return empty;

  const phase = stallPhaseOf(match);
  if (!phase) return empty;

  // "Owes something" and "ran out of time" are NOT the same thing, and only the
  // second one is ghosting. A side that tapped 🟢 an hour ago still owes its
  // action but has a fresh 48h; if the OTHER side then blows its own deadline
  // and the match dies, penalising the one who answered would be exactly
  // backwards — they did the thing the check-in asks for.
  const sides: Array<{
    side: MatchSide;
    user: StallParticipant;
    owes: boolean;
    ghosted: boolean;
  }> = (["A", "B"] as MatchSide[]).map((side) => {
    const owes = sideOwesAction(match, side);
    const deadline = stallDeadlineAt(match, side);
    return {
      side,
      user: side === "A" ? match.userA : match.userB,
      owes,
      ghosted: owes && deadline !== null && deadline <= now,
    };
  });

  // Never cancel over a side that could not have answered the question.
  if (sides.some((s) => s.owes && !stallReachableFor(s.user.telegramId))) return empty;
  // The deadline is re-derived here, from a row read AFTER the caller decided.
  // That closes the race where someone taps 🟢 in the window between the
  // worker's scan and this call: their deadline moves, nothing has expired any
  // more, and the cancellation is abandoned instead of overriding their answer.
  if (!sides.some((s) => s.ghosted)) return empty;

  if (!(await claimCancellation(matchId, phase, null))) return empty;

  const ghosts = sides.filter((s) => s.ghosted);
  // Compensated only for actually doing their part. Someone who owes but whose
  // own clock hadn't run out gets neither the penalty nor the boost.
  const waiting = sides.filter((s) => !s.owes);

  for (const ghost of ghosts) {
    try {
      const updated = await prisma.profile.update({
        where: { userId: ghost.user.id },
        data: { silentIgnoreCount: { increment: 1 } },
        select: { silentIgnoreCount: true },
      });
      // Post-increment 1 is the forgive-once warning round; beyond that the
      // same flat penalty a ghosted pitch already carries.
      if (updated.silentIgnoreCount > 1) await applySilentIgnorePenalty(ghost.user.id);
    } catch (err) {
      console.warn(
        `[match-stall] silent-ignore bookkeeping failed for ${ghost.user.id}:`,
        (err as Error).message,
      );
    }
  }

  for (const side of waiting) {
    await boostAcceptedSidePriority(side.user.id);
  }

  // The date isn't happening, so every paid ticket goes back to its payer — the
  // ghost included (PRODUCT_SPEC §3.5b). Ghosting is already priced in Elo
  // above; charging a ticket on top would make silence cost money that an
  // honest "plans changed" does not, which is the opposite of what this whole
  // stall chain is built to encourage.
  const refunds = await refundMatchTickets(matchId).catch((err: unknown) => {
    console.warn(`[match-stall] ticket refund failed for ${matchId}:`, err);
    return [];
  });
  const refundLineFor = (userId: string, lang: Language): string => {
    const key = ticketRefundNoticeKey(refunds.find((r) => r.userId === userId)?.refunded ?? 0);
    return key ? `\n\n${t(lang, key)}` : "";
  };

  // Notices. Someone who did their part hears what actually happened (their
  // partner never answered); a ghost hears why it lapsed and — the part that
  // matters for next time — that saying "plans changed" is a normal thing to do.
  for (const side of sides) {
    const lang = (side.user.language ?? "en") as Language;
    const other = side.side === "A" ? match.userB : match.userA;
    // Keyed on who actually ran the clock out, not on who still owes: a side
    // that answered the check-in and was cancelled by the OTHER one is told the
    // truth — their partner never came back.
    const key = side.ghosted ? "stallTimeoutSelf" : "stallTimeoutPartnerGone";
    const body = `${t(lang, key, { name: partnerName(other, lang) })}${refundLineFor(side.user.id, lang)}`;

    if (!stallReachableFor(side.user.telegramId)) {
      // A mobile-only participant can't be asked (which is why they are never
      // the ghost), but their match still just ended — silently dropping it from
      // `/v1/matches/current` on the next poll is not an explanation.
      await sendPushToUser(side.user.id, {
        title: "Gennety",
        body,
        data: { type: "match.cancelled", matchId },
      }).catch((err: unknown) => {
        console.warn(`[match-stall] timeout push failed for ${side.user.id}:`, err);
      });
      continue;
    }

    try {
      await api.sendMessage(Number(side.user.telegramId), body);
    } catch (err) {
      console.warn(
        `[match-stall] timeout notice failed for ${side.user.telegramId}:`,
        (err as Error).message,
      );
    }
  }

  console.log(
    `[match-stall] timeout cancelled match=${matchId} phase=${phase} ` +
      `ghosts=${ghosts.length} waiting=${waiting.length}`,
  );

  return {
    cancelled: true,
    ghostUserIds: ghosts.map((s) => s.user.id),
    waitingUserIds: waiting.map((s) => s.user.id),
  };
}

export interface StallUserCancelResult {
  cancelled: boolean;
  /** Localized line to show the person who cancelled. */
  ackText: string | null;
}

/**
 * A participant ends the planning themselves ("plans changed").
 *
 * Deliberately free of any penalty: this is the behaviour the whole check-in
 * exists to produce, and charging for it would make silence the cheaper move.
 * The partner is compensated exactly as if they had been ghosted — their week
 * is gone either way — and is told the truth without being told anything
 * embarrassing about the other person.
 */
export async function cancelPlanningByUser(
  api: Api<RawApi>,
  matchId: string,
  actorUserId: string,
): Promise<StallUserCancelResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: STALL_MATCH_SELECT,
  });
  if (!match) return { cancelled: false, ackText: null };
  const phase = stallPhaseOf(match);
  if (!phase) return { cancelled: false, ackText: null };

  const isA = match.userAId === actorUserId;
  const isB = match.userBId === actorUserId;
  if (!isA && !isB) return { cancelled: false, ackText: null };

  if (!(await claimCancellation(matchId, phase, actorUserId))) {
    return { cancelled: false, ackText: null };
  }

  const actor = isA ? match.userA : match.userB;
  const other = isA ? match.userB : match.userA;
  const actorLang = (actor.language ?? "en") as Language;

  await boostAcceptedSidePriority(other.id);

  // Same rule as the timeout above: no date, so every paid ticket goes home.
  // The actor is refunded too — this is the honest exit the flow wants used, and
  // it must not be the expensive one (PRODUCT_SPEC §3.5b).
  const refunds = await refundMatchTickets(matchId).catch((err: unknown) => {
    console.warn(`[match-stall] ticket refund failed for ${matchId}:`, err);
    return [];
  });
  const refundLineFor = (userId: string, lang: Language): string => {
    const key = ticketRefundNoticeKey(refunds.find((r) => r.userId === userId)?.refunded ?? 0);
    return key ? `\n\n${t(lang, key)}` : "";
  };

  const otherLang = (other.language ?? "en") as Language;
  const otherBody =
    `${t(otherLang, "stallPeerCancelled", { name: partnerName(actor, otherLang) })}` +
    refundLineFor(other.id, otherLang);

  if (stallReachableFor(other.telegramId)) {
    try {
      await api.sendMessage(Number(other.telegramId), otherBody);
    } catch (err) {
      console.warn(
        `[match-stall] cancel notice failed for ${other.telegramId}:`,
        (err as Error).message,
      );
    }
  } else {
    // Mobile-only partner: the match vanishing from their next poll is not an
    // explanation, and this one has a real cause worth stating.
    await sendPushToUser(other.id, {
      title: "Gennety",
      body: otherBody,
      data: { type: "match.cancelled", matchId },
    }).catch((err: unknown) => {
      console.warn(`[match-stall] cancel push failed for ${other.id}:`, err);
    });
  }

  console.log(`[match-stall] user cancelled planning match=${matchId} by=${actorUserId}`);

  return {
    cancelled: true,
    ackText:
      t(actorLang, "stallCancelDone", { name: partnerName(other, actorLang) }) +
      refundLineFor(actor.id, actorLang),
  };
}
