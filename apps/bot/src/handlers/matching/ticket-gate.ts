import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { isTelegramTarget, toTelegramChatId } from "../../utils/telegram-target.js";
import { startScheduling } from "./scheduler.js";
import {
  amountForScope,
  ticketsForScope,
  type TicketScope,
  type PaymentMode,
  refundTicketPayment,
} from "../../services/ticket-payment.js";
import { spendTickets, grantTickets } from "../../services/ticket-wallet.js";
import {
  activeDiscountFromColumns,
  consumeActiveDiscount,
  discountedCents,
} from "../../services/ticket-discount.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";

/**
 * Date Ticket gate — the premium monetization step inserted between mutual
 * accept and the Calendar Mini App when `TICKET_FEATURE_ENABLED=true`.
 *
 * Flow:
 *   mutual accept ──▶ sendTicketOffer (DMs both the ticket Mini App button)
 *   both pay      ──▶ completeTicketGateAndUnlockScheduling ──▶ startScheduling
 *   partial lapse ──▶ refundAndFallbackToScheduling ──▶ startScheduling (free)
 *
 * The match stays in `negotiating` the whole time — `ticketStatus` is the
 * sub-state machine. We never invent a new `MatchStatus` so the rest of the
 * scheduling/venue/lifecycle code is untouched.
 */

type Side = "A" | "B";

const PARTIAL_WINDOW_MS = Math.max(1, Math.round(env.TICKET_PAYMENT_WINDOW_HOURS * 3_600_000));

interface TicketUser {
  id: string;
  telegramId: bigint;
  language: string | null;
  gender: "male" | "female" | null;
  firstName: string | null;
  ticketBalance: number;
  ticketDiscountPct: number;
  ticketDiscountExpiresAt: Date | null;
  ticketDiscountConsumedAt: Date | null;
}

interface TicketMatch {
  id: string;
  status: string;
  ticketStatus: string;
  ticketPriceCents: number;
  ticketPaidA: Date | null;
  ticketPaidB: Date | null;
  paidForPartnerByA: boolean;
  paidForPartnerByB: boolean;
  ticketExpiresAt: Date | null;
  calendarMessageIdA: number | null;
  calendarMessageIdB: number | null;
  userAId: string;
  userBId: string;
  userA: TicketUser;
  userB: TicketUser;
}

const TICKET_SELECT = {
  id: true,
  status: true,
  ticketStatus: true,
  ticketPriceCents: true,
  ticketPaidA: true,
  ticketPaidB: true,
  paidForPartnerByA: true,
  paidForPartnerByB: true,
  ticketExpiresAt: true,
  calendarMessageIdA: true,
  calendarMessageIdB: true,
  userAId: true,
  userBId: true,
  userA: { select: { id: true, telegramId: true, language: true, gender: true, firstName: true, ticketBalance: true, ticketDiscountPct: true, ticketDiscountExpiresAt: true, ticketDiscountConsumedAt: true } },
  userB: { select: { id: true, telegramId: true, language: true, gender: true, firstName: true, ticketBalance: true, ticketDiscountPct: true, ticketDiscountExpiresAt: true, ticketDiscountConsumedAt: true } },
} as const;

function loadTicketMatch(matchId: string): Promise<TicketMatch | null> {
  return prisma.match.findUnique({ where: { id: matchId }, select: TICKET_SELECT });
}

function langOf(user: TicketUser): Language {
  return (user.language ?? "en") as Language;
}

function sideForTelegramId(match: TicketMatch, telegramId: bigint): Side | null {
  if (match.userA.telegramId === telegramId) return "A";
  if (match.userB.telegramId === telegramId) return "B";
  return null;
}

function selfUser(match: TicketMatch, side: Side): TicketUser {
  return side === "A" ? match.userA : match.userB;
}

function peerUser(match: TicketMatch, side: Side): TicketUser {
  return side === "A" ? match.userB : match.userA;
}

// ── Public state view (shared by the GET state route + tests) ───────────────

export interface TicketStateView {
  ticketStatus: string;
  priceCents: number;
  myGender: "male" | "female" | null;
  mySide: Side;
  iPaid: boolean;
  partnerPaid: boolean;
  partnerName: string | null;
  /** True when the *partner* settled THIS user's ticket (pay-for-both). */
  partnerPaidForMe: boolean;
  bothPaid: boolean;
  expiresAt: string | null;
  paymentMode: PaymentMode;
  /** The actor's current ticket-wallet balance (balance-aware gate buttons). */
  myBalance: number;
  /**
   * Active famine single-ticket discount percent (0 = none). Applies to the
   * `self` scope only — the discounted price is `selfPriceCents`. `both`/
   * `partner` always charge `priceCents` per ticket.
   */
  selfDiscountPct: number;
  /** Charged price for the actor's OWN ticket, after `selfDiscountPct`. */
  selfPriceCents: number;
}

export function buildTicketStateView(match: TicketMatch, side: Side): TicketStateView {
  const me = selfUser(match, side);
  const peer = peerUser(match, side);
  const iPaid = (side === "A" ? match.ticketPaidA : match.ticketPaidB) !== null;
  const partnerPaid = (side === "A" ? match.ticketPaidB : match.ticketPaidA) !== null;
  // paidForPartnerByA means A paid for B. So the partner paid for ME when the
  // PARTNER's "paid for partner" flag is set.
  const partnerPaidForMe = side === "A" ? match.paidForPartnerByB : match.paidForPartnerByA;
  // Famine single-ticket discount on the actor's own ticket. Gated on the flag
  // (the columns are inert when monetization is off).
  const discount = env.TICKET_FEATURE_ENABLED
    ? activeDiscountFromColumns({
        ticketDiscountPct: me.ticketDiscountPct,
        ticketDiscountExpiresAt: me.ticketDiscountExpiresAt,
        ticketDiscountConsumedAt: me.ticketDiscountConsumedAt,
      })
    : null;
  return {
    ticketStatus: match.ticketStatus,
    priceCents: match.ticketPriceCents,
    myGender: me.gender,
    mySide: side,
    iPaid,
    partnerPaid,
    partnerName: peer.firstName,
    partnerPaidForMe,
    bothPaid: iPaid && partnerPaid,
    expiresAt: match.ticketExpiresAt ? match.ticketExpiresAt.toISOString() : null,
    paymentMode: env.TICKET_PAYMENT_MODE,
    myBalance: me.ticketBalance,
    selfDiscountPct: discount?.pct ?? 0,
    selfPriceCents: discount
      ? discountedCents(match.ticketPriceCents, discount.pct)
      : match.ticketPriceCents,
  };
}

// ── Read state (for GET /v1/matches/:id/ticket/state) ───────────────────────

export type TicketStateResult =
  | { ok: false; reason: "match-not-found" | "not-participant" }
  | { ok: true; state: TicketStateView };

export async function getTicketState(
  telegramId: bigint,
  matchId: string,
): Promise<TicketStateResult> {
  const match = await loadTicketMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideForTelegramId(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  return { ok: true, state: buildTicketStateView(match, side) };
}

// ── Offer (called from the mutual-accept handler) ───────────────────────────

function ticketUrl(matchId: string, lang: Language): string {
  return `${env.WEBAPP_URL}/ticket.html?match=${matchId}&lang=${lang}`;
}

function buildTicketKeyboard(matchId: string, lang: Language): InlineKeyboardMarkup {
  const kb = new InlineKeyboard().webApp(t(lang, "ticketButton"), ticketUrl(matchId, lang));
  return { inline_keyboard: kb.inline_keyboard };
}

/**
 * Replace the immediate `startScheduling` handoff: arm the ticket gate and DM
 * both Telegram-resident users the premium ticket Mini App button. The match
 * stays `negotiating`; the Calendar is not sent until both tickets are paid.
 *
 * The ticket card is a PERSISTENT, re-openable entry — sent once as a
 * standalone message and never edited or deleted. Tapping it always opens the
 * Mini App, which re-derives the live state (offer / "your match paid ❤️"
 * surprise / both secured). It is deliberately NOT stored in
 * `calendarMessageId*` (that tracks the separate Calendar card), so the
 * scheduling / venue / time-lock flows never touch it: the Calendar arrives as
 * a SEPARATE message that *follows* the ticket card, and the woman can always
 * reopen the ticket card to discover her match covered her. PRODUCT_SPEC §3.5b.
 */
export async function sendTicketOffer(api: Api<RawApi>, matchId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + PARTIAL_WINDOW_MS);
  await prisma.match.update({
    where: { id: matchId },
    data: {
      ticketStatus: "pending",
      ticketPriceCents: env.TICKET_PRICE_CENTS,
      ticketExpiresAt: expiresAt,
    },
  });

  const match = await loadTicketMatch(matchId);
  if (!match) return;

  emitTicketEvent("ticket_offer_sent", { matchId });

  const sends: Array<Promise<unknown>> = [];
  for (const user of [match.userA, match.userB]) {
    if (!isTelegramTarget(user.telegramId)) continue;
    sends.push(
      api.sendMessage(
        toTelegramChatId(user.telegramId),
        t(langOf(user), "ticketCardCaption"),
        {
          parse_mode: "Markdown",
          reply_markup: buildTicketKeyboard(matchId, langOf(user)),
        },
      ),
    );
  }
  await Promise.all(sends);
}

// ── Payment apply (called from POST confirm) ────────────────────────────────

export type ApplyPaymentResult =
  | {
      ok: false;
      reason:
        | "match-not-found"
        | "not-participant"
        | "wrong-state"
        | "scope-not-allowed"
        | "insufficient-balance";
    }
  | { ok: true; state: TicketStateView };

/**
 * Settle one or two ticket slots on a match (idempotent + race-safe) and
 * advance the gate. Shared by the money path (`applyTicketPayment`) and the
 * wallet path (`useTicketFromBalance`); the balance spend itself is handled by
 * the caller so this stays purely about the match state.
 *
 * `claimedCount` reports how many ticket slots THIS call actually flipped (0 on
 * an idempotent duplicate / lost race, 1 for self/partner, up to 2 for "both")
 * so the wallet path can refund any surplus it spent — e.g. a "both" spend where
 * the partner had already paid only settles one slot, so the extra ticket is
 * returned instead of silently burned.
 */
async function settleTicket(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  scope: TicketScope,
): Promise<{ result: ApplyPaymentResult; claimedCount: number }> {
  const match = await loadTicketMatch(matchId);
  if (!match) return { result: { ok: false, reason: "match-not-found" }, claimedCount: 0 };
  const side = sideForTelegramId(match, telegramId);
  if (!side) return { result: { ok: false, reason: "not-participant" }, claimedCount: 0 };

  const me = selfUser(match, side);
  if ((scope === "both" || scope === "partner") && me.gender !== "male") {
    return { result: { ok: false, reason: "scope-not-allowed" }, claimedCount: 0 };
  }

  const paidField = side === "A" ? "ticketPaidA" : "ticketPaidB";
  const partnerPaidField = side === "A" ? "ticketPaidB" : "ticketPaidA";
  const paidForPartnerField = side === "A" ? "paidForPartnerByA" : "paidForPartnerByB";
  const now = new Date();

  const myPaidAlready = (side === "A" ? match.ticketPaidA : match.ticketPaidB) !== null;
  const partnerPaidAlready = (side === "A" ? match.ticketPaidB : match.ticketPaidA) !== null;

  let claimedCount = 0;

  if (scope === "partner") {
    // Cover only the partner's slot — requires the actor to have already paid
    // their own ticket. Atomic claim on the partner's still-null slot.
    if (!myPaidAlready) {
      return { result: { ok: false, reason: "wrong-state" }, claimedCount: 0 };
    }
    if (!partnerPaidAlready) {
      const claim = await prisma.match.updateMany({
        where: { id: matchId, status: "negotiating", [partnerPaidField]: null },
        data: { [partnerPaidField]: now, [paidForPartnerField]: true },
      });
      claimedCount = claim.count > 0 ? 1 : 0;
      if (claimedCount > 0) {
        emitTicketEvent("ticket_paid", { matchId, side, scope, amountCents: amountForScope(scope, match.ticketPriceCents) });
      }
    }
  } else if (!myPaidAlready) {
    // Atomic claim — only the caller that flips the still-null field wins, so a
    // double-tap / retried confirm can't double-charge or double-advance. Same
    // pattern as the accept-transition race guard in decision.ts.
    //
    // Only cover the partner's slot when "both" is requested AND she hasn't
    // already paid. Marking `paidForPartner` / claiming her slot when she's
    // already paid would burn a wallet ticket with no refund and wrongly fire
    // her "your match paid ❤️" surprise.
    const coverPartner = scope === "both" && !partnerPaidAlready;
    const data: Record<string, unknown> = { [paidField]: now };
    if (coverPartner) {
      data[paidForPartnerField] = true;
      data[partnerPaidField] = now;
    }
    const claim = await prisma.match.updateMany({
      where: { id: matchId, status: "negotiating", [paidField]: null },
      data,
    });
    if (claim.count === 0) {
      // Lost the race or wrong state. Re-read; if our side is now paid it was a
      // concurrent duplicate — treat as success (idempotent).
      const fresh = await loadTicketMatch(matchId);
      if (!fresh) return { result: { ok: false, reason: "match-not-found" }, claimedCount: 0 };
      const sidePaidNow = (side === "A" ? fresh.ticketPaidA : fresh.ticketPaidB) !== null;
      if (!sidePaidNow) return { result: { ok: false, reason: "wrong-state" }, claimedCount: 0 };
      return { result: { ok: true, state: buildTicketStateView(fresh, side) }, claimedCount: 0 };
    }
    claimedCount = coverPartner ? 2 : 1;
    emitTicketEvent("ticket_paid", { matchId, side, scope, amountCents: amountForScope(scope, match.ticketPriceCents) });

  }

  // Recompute terminal state from fresh data.
  const after = await loadTicketMatch(matchId);
  if (!after) return { result: { ok: false, reason: "match-not-found" }, claimedCount };
  const bothPaid = after.ticketPaidA !== null && after.ticketPaidB !== null;

  if (bothPaid && after.ticketStatus !== "completed") {
    await completeTicketGateAndUnlockScheduling(api, matchId);
  } else if (!bothPaid && after.ticketStatus === "pending") {
    // First payment → partial; give the second side a fresh window.
    await prisma.match.update({
      where: { id: matchId },
      data: { ticketStatus: "partial", ticketExpiresAt: new Date(Date.now() + PARTIAL_WINDOW_MS) },
    });
  }

  // The ticket card is permanent + untracked; the Mini App shows the live
  // "waiting / both secured / surprise" state, so there is no in-chat card to
  // edit here. The Calendar follows as its own message via startScheduling.
  const final = await loadTicketMatch(matchId);
  if (!final) return { result: { ok: false, reason: "match-not-found" }, claimedCount };
  return { result: { ok: true, state: buildTicketStateView(final, side) }, claimedCount };
}

/**
 * Money path: mark the acting side's ticket(s) paid. Scope `both` ($13.98) and
 * `partner` are male-only; `both` also settles the partner's ticket.
 */
export async function applyTicketPayment(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  scope: TicketScope,
): Promise<ApplyPaymentResult> {
  const { result, claimedCount } = await settleTicket(api, telegramId, matchId, scope);
  // A discounted `self` money purchase just settled — redeem the one-time famine
  // discount. The route charged `selfPriceCents`; both branch on the same
  // active-discount predicate, and the consume CAS is idempotent.
  if (result.ok && claimedCount > 0 && scope === "self" && env.TICKET_FEATURE_ENABLED) {
    const match = await loadTicketMatch(matchId);
    const side = match ? sideForTelegramId(match, telegramId) : null;
    if (match && side) {
      const me = selfUser(match, side);
      const active = activeDiscountFromColumns({
        ticketDiscountPct: me.ticketDiscountPct,
        ticketDiscountExpiresAt: me.ticketDiscountExpiresAt,
        ticketDiscountConsumedAt: me.ticketDiscountConsumedAt,
      });
      if (active) await consumeActiveDiscount(me.id);
    }
  }
  return result;
}

/**
 * Wallet path: spend ticket(s) from the actor's balance to settle the gate.
 * The spend happens first (atomic, guarded against negatives); if the match
 * claim then doesn't apply (lost race / already-paid duplicate) the tickets are
 * refunded so the balance never leaks.
 */
export async function useTicketFromBalance(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  scope: TicketScope,
): Promise<ApplyPaymentResult> {
  const match = await loadTicketMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideForTelegramId(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const me = selfUser(match, side);
  if ((scope === "both" || scope === "partner") && me.gender !== "male") {
    return { ok: false, reason: "scope-not-allowed" };
  }

  const count = ticketsForScope(scope);
  const spend = await spendTickets({ userId: me.id, count, reason: "spend_match", matchId });
  if (!spend.ok) return { ok: false, reason: "insufficient-balance" };

  const { result, claimedCount } = await settleTicket(api, telegramId, matchId, scope);
  // Refund the surplus = tickets spent minus slots actually settled. A hard
  // failure / idempotent duplicate settles 0 (full refund); a "both"/"use 2"
  // spend that only settled one slot because the partner had already paid
  // refunds the extra one, so a wallet ticket is never silently burned.
  const refundCount = Math.max(0, count - claimedCount);
  if (refundCount > 0) {
    await grantTickets({ userId: me.id, count: refundCount, reason: "refund", matchId });
  }
  return result;
}

// ── Completion + free-fallback (shared by confirm + cron) ───────────────────

/**
 * Both tickets paid: mark `completed`, clear the partial deadline, then hand
 * off to the existing scheduler. The scheduler edits the same post-accept CTA
 * into the Calendar button, instead of adding a separate "both tickets" DM.
 */
export async function completeTicketGateAndUnlockScheduling(
  api: Api<RawApi>,
  matchId: string,
): Promise<void> {
  const flip = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating", ticketStatus: { not: "completed" } },
    data: { ticketStatus: "completed", ticketExpiresAt: null },
  });
  if (flip.count === 0) return; // already completed / wrong state

  emitTicketEvent("ticket_both_paid", { matchId });

  // The persistent ticket card stays in chat untouched; the Calendar is sent as
  // a SEPARATE message that follows it (calendarMessageId* starts null here, so
  // startScheduling sends fresh Calendar cards). The covered woman can still
  // reopen the ticket card for the "your match paid ❤️" surprise. `afterTicketGate`
  // makes the Calendar card use a plain caption so it doesn't repeat the ticket
  // card's "It's mutual 🔥" celebration. §3.5b.
  await startScheduling(api, matchId, { afterTicketGate: true });
}

/**
 * A `partial` (or `pending`) ticket lapsed. Refund whoever paid (mock = no-op),
 * mark the row terminal, DM the payer, then open the Calendar for FREE — an
 * already-accepted match must never be killed by a payment stall.
 */
export async function refundAndFallbackToScheduling(
  api: Api<RawApi>,
  matchId: string,
): Promise<void> {
  const match = await loadTicketMatch(matchId);
  if (!match) return;
  if (match.status !== "negotiating") return;
  if (match.ticketStatus === "completed" || match.ticketStatus === "refunded" || match.ticketStatus === "expired") {
    return; // already terminal — idempotent
  }

  const paidSide: Side | null = match.ticketPaidA !== null ? "A" : match.ticketPaidB !== null ? "B" : null;
  const terminal = paidSide ? "refunded" : "expired";

  // Claim the terminal flip atomically so a double cron tick refunds once.
  const flip = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating", ticketStatus: { in: ["pending", "partial"] } },
    data: { ticketStatus: terminal, ticketExpiresAt: null },
  });
  if (flip.count === 0) return;

  if (paidSide) {
    await refundTicketPayment({ matchId, amountCents: match.ticketPriceCents });
    emitTicketEvent("ticket_refunded", { matchId, side: paidSide });
    const payer = selfUser(match, paidSide);
    if (isTelegramTarget(payer.telegramId)) {
      await api.sendMessage(toTelegramChatId(payer.telegramId), t(langOf(payer), "ticketRefundedDm"));
    }
  }

  // Open scheduling for free. The persistent ticket card is still above, so the
  // Calendar follows it with the plain (non-duplicating) caption.
  await startScheduling(api, matchId, { afterTicketGate: true });
}
