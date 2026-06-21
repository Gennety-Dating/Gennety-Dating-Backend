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
import {
  sendOrEditPostAcceptMessage,
  type PostAcceptSide,
} from "./post-accept-message.js";

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

function messageIdForSide(match: TicketMatch, side: PostAcceptSide): number | null {
  return side === "A" ? match.calendarMessageIdA : match.calendarMessageIdB;
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

function buildTicketStatusKeyboard(matchId: string, lang: Language): InlineKeyboardMarkup {
  const kb = new InlineKeyboard().webApp(t(lang, "ticketStatusButton"), ticketUrl(matchId, lang));
  return { inline_keyboard: kb.inline_keyboard };
}

async function sendOrEditTicketStatus(
  api: Api<RawApi>,
  match: TicketMatch,
  side: PostAcceptSide,
  text: string,
  replyMarkup: InlineKeyboardMarkup | null,
): Promise<void> {
  const user = side === "A" ? match.userA : match.userB;
  if (!isTelegramTarget(user.telegramId)) return;
  await sendOrEditPostAcceptMessage({
    api,
    matchId: match.id,
    side,
    telegramId: user.telegramId,
    previousMessageId: messageIdForSide(match, side),
    text,
    options: {
      parse_mode: "Markdown",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
  });
}

/**
 * Replace the immediate `startScheduling` handoff: arm the ticket gate and DM
 * both Telegram-resident users the premium ticket Mini App button. The match
 * stays `negotiating`; the Calendar is not sent until both tickets are paid.
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

  await Promise.all([
    sendOrEditTicketStatus(
      api,
      match,
      "A",
      t(langOf(match.userA), "ticketCardCaption"),
      buildTicketKeyboard(matchId, langOf(match.userA)),
    ),
    sendOrEditTicketStatus(
      api,
      match,
      "B",
      t(langOf(match.userB), "ticketCardCaption"),
      buildTicketKeyboard(matchId, langOf(match.userB)),
    ),
  ]);
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
 * `claimed` reports whether THIS call actually flipped a slot (vs an idempotent
 * duplicate / lost race) so the wallet path knows whether to keep or refund the
 * tickets it already spent.
 */
async function settleTicket(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  scope: TicketScope,
): Promise<{ result: ApplyPaymentResult; claimed: boolean }> {
  const match = await loadTicketMatch(matchId);
  if (!match) return { result: { ok: false, reason: "match-not-found" }, claimed: false };
  const side = sideForTelegramId(match, telegramId);
  if (!side) return { result: { ok: false, reason: "not-participant" }, claimed: false };

  const me = selfUser(match, side);
  if ((scope === "both" || scope === "partner") && me.gender !== "male") {
    return { result: { ok: false, reason: "scope-not-allowed" }, claimed: false };
  }

  const paidField = side === "A" ? "ticketPaidA" : "ticketPaidB";
  const partnerPaidField = side === "A" ? "ticketPaidB" : "ticketPaidA";
  const paidForPartnerField = side === "A" ? "paidForPartnerByA" : "paidForPartnerByB";
  const now = new Date();

  const myPaidAlready = (side === "A" ? match.ticketPaidA : match.ticketPaidB) !== null;
  const partnerPaidAlready = (side === "A" ? match.ticketPaidB : match.ticketPaidA) !== null;

  let claimed = false;

  if (scope === "partner") {
    // Cover only the partner's slot — requires the actor to have already paid
    // their own ticket. Atomic claim on the partner's still-null slot.
    if (!myPaidAlready) {
      return { result: { ok: false, reason: "wrong-state" }, claimed: false };
    }
    if (!partnerPaidAlready) {
      const claim = await prisma.match.updateMany({
        where: { id: matchId, status: "negotiating", [partnerPaidField]: null },
        data: { [partnerPaidField]: now, [paidForPartnerField]: true },
      });
      claimed = claim.count > 0;
      if (claimed) {
        emitTicketEvent("ticket_paid", { matchId, side, scope, amountCents: amountForScope(scope, match.ticketPriceCents) });
      }
    }
  } else if (!myPaidAlready) {
    // Atomic claim — only the caller that flips the still-null field wins, so a
    // double-tap / retried confirm can't double-charge or double-advance. Same
    // pattern as the accept-transition race guard in decision.ts.
    const data: Record<string, unknown> = { [paidField]: now };
    if (scope === "both") {
      data[paidForPartnerField] = true;
      if (!partnerPaidAlready) data[partnerPaidField] = now;
    }
    const claim = await prisma.match.updateMany({
      where: { id: matchId, status: "negotiating", [paidField]: null },
      data,
    });
    if (claim.count === 0) {
      // Lost the race or wrong state. Re-read; if our side is now paid it was a
      // concurrent duplicate — treat as success (idempotent).
      const fresh = await loadTicketMatch(matchId);
      if (!fresh) return { result: { ok: false, reason: "match-not-found" }, claimed: false };
      const sidePaidNow = (side === "A" ? fresh.ticketPaidA : fresh.ticketPaidB) !== null;
      if (!sidePaidNow) return { result: { ok: false, reason: "wrong-state" }, claimed: false };
      return { result: { ok: true, state: buildTicketStateView(fresh, side) }, claimed: false };
    }
    claimed = true;
    emitTicketEvent("ticket_paid", { matchId, side, scope, amountCents: amountForScope(scope, match.ticketPriceCents) });

  }

  // Recompute terminal state from fresh data.
  const after = await loadTicketMatch(matchId);
  if (!after) return { result: { ok: false, reason: "match-not-found" }, claimed };
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

  const final = await loadTicketMatch(matchId);
  if (!final) return { result: { ok: false, reason: "match-not-found" }, claimed };
  if (!bothPaid && claimed) {
    const actor = selfUser(final, side);
    const actorLang = langOf(actor);
    await sendOrEditTicketStatus(
      api,
      final,
      side,
      t(actorLang, "ticketGateWaiting"),
      buildTicketStatusKeyboard(matchId, actorLang),
    );
  }
  return { result: { ok: true, state: buildTicketStateView(final, side) }, claimed };
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
  const { result, claimed } = await settleTicket(api, telegramId, matchId, scope);
  // A discounted `self` money purchase just settled — redeem the one-time famine
  // discount. The route charged `selfPriceCents`; both branch on the same
  // active-discount predicate, and the consume CAS is idempotent.
  if (result.ok && claimed && scope === "self" && env.TICKET_FEATURE_ENABLED) {
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

  const { result, claimed } = await settleTicket(api, telegramId, matchId, scope);
  // Refund when the tickets were spent but no slot was actually claimed —
  // either a hard failure or an idempotent duplicate that consumed nothing.
  if (!result.ok || !claimed) {
    await grantTickets({ userId: me.id, count, reason: "refund", matchId });
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

  await startScheduling(api, matchId);
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

  // Open scheduling for free.
  await startScheduling(api, matchId);
}
