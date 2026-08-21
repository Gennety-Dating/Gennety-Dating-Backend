import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma, type Theme } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { isTelegramTarget, toTelegramChatId } from "../../utils/telegram-target.js";
import { startScheduling, sendCalendarCard } from "./scheduler.js";
import {
  amountForScope,
  ticketsForScope,
  gateStarsForScope,
  type TicketScope,
  type PaymentMode,
  refundTicketPayment,
} from "../../services/ticket-payment.js";
import {
  notifyFounderPurchase,
  notifyFounderPurchaseRefunded,
} from "../../services/founder-notify.js";
import { spendTickets, grantTickets, isUniqueViolation } from "../../services/ticket-wallet.js";
import {
  activeDiscountFromColumns,
  consumeActiveDiscount,
  discountedCents,
} from "../../services/ticket-discount.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";
import { isPremiumHeadActive } from "../../services/premium.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";

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

/**
 * When the gate's payment window closes, from `now`.
 *
 * Exported because the deadline is armed by the SAME compare-and-set that flips
 * the match to `negotiating` (`handlers/matching/decision.ts` and its mobile
 * twin in `public/matches-service.ts`), not by `sendTicketOffer` alone.
 *
 * That matters more than it looks. `ticketExpiresAt` is what the hourly
 * ticket-expiry sweep filters on (`{ not: null }`), and the §3.5c stall chain
 * deliberately exempts a `negotiating` row with no `proposedTimes` on the
 * grounds that "the gate has its own deadline". Both are true only while the
 * deadline is actually set — a row that reaches `negotiating` without one is
 * invisible to both at once, which is the same permanent hole `dispatchedAt`
 * used to open one stage earlier (§3.3). Arming it inside the transition makes
 * that unreachable by construction rather than by nothing throwing in between.
 */
export function ticketGateDeadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + PARTIAL_WINDOW_MS);
}

interface TicketUser {
  id: string;
  telegramId: bigint;
  language: string | null;
  theme: Theme;
  gender: "male" | "female" | null;
  firstName: string | null;
  ticketBalance: number;
  ticketDiscountPct: number;
  ticketDiscountExpiresAt: Date | null;
  ticketDiscountConsumedAt: Date | null;
  /** Gennety Premium head (§3.8). An active subscription settles this user's
   *  OWN ticket slot for free — see `settlePremiumSlots`. Read straight off the
   *  loaded row so no surface needs a second query to decide. */
  premiumUntil: Date | null;
  /** Ordered static profile photos (Telegram file_id / Supabase path). Used to
   *  surface the first photo as an avatar in the ticket Mini App. */
  profile: { photos: string[] } | null;
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
  partnerPaidSeenAt: Date | null;
  partnerPaidNudgedAt: Date | null;
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
  partnerPaidSeenAt: true,
  partnerPaidNudgedAt: true,
  ticketExpiresAt: true,
  calendarMessageIdA: true,
  calendarMessageIdB: true,
  userAId: true,
  userBId: true,
  userA: { select: { id: true, telegramId: true, language: true, theme: true, gender: true, firstName: true, ticketBalance: true, ticketDiscountPct: true, ticketDiscountExpiresAt: true, ticketDiscountConsumedAt: true, premiumUntil: true, profile: { select: { photos: true } } } },
  userB: { select: { id: true, telegramId: true, language: true, theme: true, gender: true, firstName: true, ticketBalance: true, ticketDiscountPct: true, ticketDiscountExpiresAt: true, ticketDiscountConsumedAt: true, premiumUntil: true, profile: { select: { photos: true } } } },
} as const;

function loadTicketMatch(matchId: string): Promise<TicketMatch | null> {
  return prisma.match.findUnique({ where: { id: matchId }, select: TICKET_SELECT });
}

/** First usable static profile photo ref (Telegram file_id / Supabase path), or null. */
function firstPhotoRef(user: TicketUser): string | null {
  const ref = user.profile?.photos?.[0];
  return typeof ref === "string" && ref.length > 0 ? ref : null;
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
  /** True when THIS user (the male) settled the partner's ticket — drives his
   * "you covered {name}'s ticket 💛" success screen instead of a neutral one. */
  iCoveredPartner: boolean;
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
  /** Relative proxy path to the actor's own first profile photo (null if none).
   *  The Mini App loads it via `<img>` after appending `?a=<initData>`. */
  myPhotoUrl: string | null;
  /** Relative proxy path to the partner's first profile photo (null if none). */
  partnerPhotoUrl: string | null;
  /**
   * The actor holds an active Gennety Premium subscription RIGHT NOW (§3.8) —
   * i.e. their own slot is covered by it and costs nothing.
   *
   * Deliberately a statement about the subscription rather than about the slot,
   * because nothing on the row records HOW a slot was settled and no column was
   * added for it. That makes it honest by construction in the one case that
   * matters: a subscription which lapsed after the slot was claimed reads
   * `false` here, the slot stays settled (§3.5b — a paid slot is never revoked),
   * and the client simply renders no "covered by Premium" plate rather than a
   * claim the product can no longer stand behind.
   */
  myPremiumActive: boolean;
}

export function buildTicketStateView(match: TicketMatch, side: Side): TicketStateView {
  const me = selfUser(match, side);
  const peer = peerUser(match, side);
  const iPaid = (side === "A" ? match.ticketPaidA : match.ticketPaidB) !== null;
  const partnerPaid = (side === "A" ? match.ticketPaidB : match.ticketPaidA) !== null;
  // paidForPartnerByA means A paid for B. So the partner paid for ME when the
  // PARTNER's "paid for partner" flag is set.
  const partnerPaidForMe = side === "A" ? match.paidForPartnerByB : match.paidForPartnerByA;
  // I covered the partner when MY "paid for partner" flag is set.
  const iCoveredPartner = side === "A" ? match.paidForPartnerByA : match.paidForPartnerByB;
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
    iCoveredPartner,
    bothPaid: iPaid && partnerPaid,
    expiresAt: match.ticketExpiresAt ? match.ticketExpiresAt.toISOString() : null,
    paymentMode: env.TICKET_PAYMENT_MODE,
    myBalance: me.ticketBalance,
    selfDiscountPct: discount?.pct ?? 0,
    selfPriceCents: discount
      ? discountedCents(match.ticketPriceCents, discount.pct)
      : match.ticketPriceCents,
    myPhotoUrl: firstPhotoRef(me) ? `/v1/matches/${match.id}/ticket/photo/self` : null,
    partnerPhotoUrl: firstPhotoRef(peer) ? `/v1/matches/${match.id}/ticket/photo/partner` : null,
    // NOT gated on PREMIUM_FEATURE_ENABLED, deliberately: `services/premium.ts`
    // states that an entitlement a user already paid for stays valid whatever
    // the flag says, and the flag gates new purchase surfaces instead. Gating
    // here would strip a benefit from someone still inside a paid period.
    myPremiumActive: isPremiumHeadActive(me),
  };
}

// ── Read state (for GET /v1/matches/:id/ticket/state) ───────────────────────

export type TicketStateResult =
  | { ok: false; reason: "match-not-found" | "not-participant" }
  | { ok: true; state: TicketStateView };

export async function getTicketState(
  telegramId: bigint,
  matchId: string,
  api?: Api<RawApi>,
): Promise<TicketStateResult> {
  const match = await loadTicketMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideForTelegramId(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };

  // Self-healing for a subscription bought AFTER the gate opened — the case the
  // counterfactual upsell on this very screen is designed to produce.
  //
  // Doing it here rather than hooking premium activation is deliberate: Premium
  // is granted through FOUR rails (Telegram Stars, App Store, and the referral
  // and promo comp grants via `grantComplimentaryPremiumMonths`), and a hook on
  // each is four places to forget. This screen is polled, so a settle lands
  // within seconds whichever rail was used. The guard reads the row already in
  // hand, so an ordinary poll costs no extra query, and the claim itself is the
  // same CAS as everywhere else — a read racing `sendTicketOffer`, or two polls
  // racing each other, claim zero slots rather than double-settling.
  if (api && premiumCanSettle(match, side)) {
    const fresh = await settlePremiumOnRead(api, matchId);
    if (fresh) return { ok: true, state: buildTicketStateView(fresh, side) };
  }

  return { ok: true, state: buildTicketStateView(match, side) };
}

/** Cheap pre-check on an already-loaded row: could a premium settle do anything? */
function premiumCanSettle(match: TicketMatch, side: Side): boolean {
  if (match.status !== "negotiating") return false;
  if (!OPEN_GATE_STATUSES.includes(match.ticketStatus as (typeof OPEN_GATE_STATUSES)[number])) {
    return false;
  }
  if ((side === "A" ? match.ticketPaidA : match.ticketPaidB) !== null) return false;
  return isPremiumHeadActive(selfUser(match, side));
}

/**
 * Settle premium slots from a state READ and complete the gate if that closed
 * it, returning the fresh row when anything actually changed.
 *
 * The completion belongs here rather than in `settlePremiumSlots` because the
 * two callers need opposite ordering: `sendTicketOffer` must put the mutual
 * reveal on screen BEFORE the Calendar, while a read has no such card to wait
 * for — the ticket card went out long ago. Without it, a pair whose second slot
 * is closed by a late subscription would sit fully paid in `partial` until the
 * hourly expiry sweep refunded them out of a date they had already secured.
 */
async function settlePremiumOnRead(
  api: Api<RawApi>,
  matchId: string,
): Promise<TicketMatch | null> {
  const claimed = await settlePremiumSlots(matchId);
  if (claimed.length === 0) return null;
  const after = await loadTicketMatch(matchId);
  if (!after) return null;
  if (
    after.ticketPaidA !== null &&
    after.ticketPaidB !== null &&
    after.ticketStatus !== "completed"
  ) {
    await completeTicketGateAndUnlockScheduling(api, matchId);
    return loadTicketMatch(matchId);
  }
  return after;
}

// ── Photo ref (for GET /v1/matches/:id/ticket/photo/:side) ──────────────────

export type TicketPhotoResult =
  | { ok: false; reason: "match-not-found" | "not-participant" | "no-photo" }
  | { ok: true; ref: string };

/**
 * Resolve the first profile-photo ref for `self` (the requester) or `partner`
 * (the other side), gated on participation. The HTTP route streams the bytes
 * via `downloadProfileImage`; participation is re-checked here so a caller can
 * never fetch a photo from a match they aren't in.
 */
export async function getTicketPhoto(
  telegramId: bigint,
  matchId: string,
  which: "self" | "partner",
): Promise<TicketPhotoResult> {
  const match = await loadTicketMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideForTelegramId(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const target = which === "self" ? selfUser(match, side) : peerUser(match, side);
  const ref = firstPhotoRef(target);
  if (!ref) return { ok: false, reason: "no-photo" };
  return { ok: true, ref };
}

/**
 * Fire the one-time "she saw it ❤️" read-receipt back to the payer. Shared by
 * the view path (`notePartnerPaidSeen` — she opened the reveal) and the
 * completion fallback (`ticketPartnerPaidDm` nudge — she was DM'd instead). The
 * CAS on `partnerPaidSeenAt: null` makes it fire exactly once regardless of
 * which path (or a racing Mini App poll) gets there first. `coveredSide` is the
 * side of the covered partner; the payer is the other side.
 */
async function markPartnerPaidSeenAndNotify(
  api: Api<RawApi>,
  matchId: string,
  coveredSide: Side,
): Promise<void> {
  const claim = await prisma.match.updateMany({
    where: { id: matchId, partnerPaidSeenAt: null },
    data: { partnerPaidSeenAt: new Date() },
  });
  if (claim.count === 0) return; // already receipted — idempotent
  const match = await loadTicketMatch(matchId);
  if (!match) return;
  const covered = selfUser(match, coveredSide);
  const payer = peerUser(match, coveredSide);
  if (isTelegramTarget(payer.telegramId)) {
    await api
      .sendMessage(
        toTelegramChatId(payer.telegramId),
        t(langOf(payer), "ticketPartnerSawItDm", { name: covered.firstName ?? "" }),
      )
      .catch(() => {});
  }

  // She's now seen the reveal → deliver her deferred Calendar so she can pick a
  // time. `completeTicketGateAndUnlockScheduling` withheld it (skipSide) until
  // this moment; the CAS above guarantees this runs exactly once.
  if (match.ticketStatus === "completed") {
    await sendCalendarCard(api, matchId, coveredSide).catch(() => {});
  }
}

/**
 * Read-receipt trigger for the goodwill cover (§3.5b takt 2). Call this when the
 * covered partner opens her ticket-card reveal: if she was in fact covered and
 * hasn't been receipted yet, it stamps `partnerPaidSeenAt` and DMs the payer
 * once that she's seen his gesture. No-op for the payer's own views or an
 * uncovered match. Best-effort — it must never block or fail the state read.
 */
export async function notePartnerPaidSeen(
  api: Api<RawApi>,
  viewerTelegramId: bigint,
  matchId: string,
): Promise<void> {
  const match = await loadTicketMatch(matchId);
  if (!match) return;
  const side = sideForTelegramId(match, viewerTelegramId);
  if (!side) return;
  const partnerPaidForMe = side === "A" ? match.paidForPartnerByB : match.paidForPartnerByA;
  if (!partnerPaidForMe) return; // viewer wasn't covered — nothing to receipt
  if (match.partnerPaidSeenAt !== null) return; // already seen — fast path
  await markPartnerPaidSeenAndNotify(api, matchId, side);
}

// ── Offer (called from the mutual-accept handler) ───────────────────────────

export function ticketUrl(matchId: string, lang: Language, theme: Theme): string {
  return buildMiniAppUrl("ticket", { lang, theme, query: { match: matchId } });
}

function buildTicketKeyboard(
  matchId: string,
  lang: Language,
  theme: Theme,
  labelKey: "ticketButton" | "ticketViewButton" = "ticketButton",
): InlineKeyboardMarkup {
  const kb = new InlineKeyboard().webApp(t(lang, labelKey), ticketUrl(matchId, lang, theme));
  return { inline_keyboard: kb.inline_keyboard };
}

/** `TicketLedger.reason` for a slot covered by an active subscription. */
const PREMIUM_GATE_REASON = "premium_gate";

/**
 * Settle the ticket slot of every side holding an active Gennety Premium
 * subscription (PRODUCT_SPEC §3.5b / §3.8 — "unlimited dates"). Returns the
 * sides this call actually claimed, so the caller can tell a fresh settle from
 * an idempotent re-run.
 *
 * Three properties are load-bearing:
 *
 * 1. **It spends nothing.** Premium does NOT go through `useTicketFromBalance`:
 *    if a subscription silently drained the wallet, a subscriber would be
 *    paying for the very thing the subscription promises, which is the exact
 *    opposite of unlimited. Bought tickets are left alone — under the founder's
 *    decision they remain the way a man covers his date's slot.
 *
 * 2. **It is not `settleTicket`.** That function DMs `ticketGateWaiting` to the
 *    payer and `ticketPeerTookTheirs` ("{name} just grabbed their ticket —
 *    yours is the last one") to the peer. Here nobody grabbed anything: the
 *    slot closes at the instant of mutual accept, so those lines would describe
 *    an action that never happened and would land alongside the ticket card.
 *
 * 3. **It never completes the gate itself.** The caller does that, AFTER it has
 *    put the "It's mutual 🤍" card on screen — the same rule §2.1 states for the
 *    pinned banner: a state change may not be announced before the message that
 *    describes it. Completing here would let the Calendar overtake the reveal.
 *
 * Race-safety is the same compare-and-set every other slot claim uses: guarded
 * on the match still being `negotiating`, the gate still open (`OPEN_GATE_
 * STATUSES` — `status` alone does not close it, see there), and THIS side's slot
 * still null. So a second call, two concurrent state reads, or a read racing
 * `sendTicketOffer` all claim zero slots rather than double-settling.
 */
export async function settlePremiumSlots(matchId: string): Promise<Side[]> {
  const match = await loadTicketMatch(matchId);
  if (!match) return [];
  if (match.status !== "negotiating") return [];
  if (!OPEN_GATE_STATUSES.includes(match.ticketStatus as (typeof OPEN_GATE_STATUSES)[number])) {
    return [];
  }

  const now = new Date();
  const claimed: Side[] = [];

  for (const side of ["A", "B"] as const) {
    const user = side === "A" ? match.userA : match.userB;
    if (!isPremiumHeadActive(user, now)) continue;
    const paidField = side === "A" ? "ticketPaidA" : "ticketPaidB";
    if ((side === "A" ? match.ticketPaidA : match.ticketPaidB) !== null) continue;

    const claim = await prisma.match.updateMany({
      where: {
        id: matchId,
        status: "negotiating",
        ticketStatus: { in: [...OPEN_GATE_STATUSES] },
        [paidField]: null,
      },
      data: { [paidField]: now },
    });
    if (claim.count === 0) continue;
    claimed.push(side);

    // Zero-delta audit row, mirroring the Stars gate's own `gate_payment`
    // record. Without it the admin purchase view cannot tell "Premium covered
    // this date" from "the gate lapsed and the Calendar opened for free" — and
    // that is precisely the number that says whether the subscription is paying
    // for the dates it hands out. Best-effort: an audit write must never cost
    // someone the date their subscription just paid for.
    await prisma.ticketLedger
      .create({
        data: {
          userId: user.id,
          delta: 0,
          reason: PREMIUM_GATE_REASON,
          matchId,
          bundleSize: 1,
        },
      })
      .catch((error: unknown) => {
        console.error("[ticket-gate] premium ledger row failed", matchId, side, error);
      });

    emitTicketEvent("premium_gate_settled", { matchId, userId: user.id });
  }

  if (claimed.length === 0) return [];

  // Exactly one slot left open → this is the gate's first settle, so the other
  // side gets the same fresh window a paying first mover gives them. Guarded
  // the same way `settleTicket` guards its own `pending → partial` flip, so a
  // concurrent real payment cannot have its deadline stomped.
  const after = await loadTicketMatch(matchId);
  if (after && after.ticketPaidA !== null && after.ticketPaidB !== null) return claimed;
  await prisma.match.updateMany({
    where: {
      id: matchId,
      status: "negotiating",
      ticketStatus: "pending",
      OR: [{ ticketPaidA: null }, { ticketPaidB: null }],
    },
    data: { ticketStatus: "partial", ticketExpiresAt: ticketGateDeadline() },
  });
  return claimed;
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
  const expiresAt = ticketGateDeadline();
  await prisma.match.update({
    where: { id: matchId },
    data: {
      ticketStatus: "pending",
      ticketPriceCents: env.TICKET_PRICE_CENTS,
      ticketExpiresAt: expiresAt,
    },
  });

  let match = await loadTicketMatch(matchId);
  if (!match) return;

  // Gennety Premium covers a subscriber's own slot (§3.5b / §3.8). Settled
  // BEFORE anything is sent, so each side's card opens on the screen that is
  // actually true for them — a covered woman on "waiting", a covered man on
  // "cover-partner", which is the one screen where he still has a choice.
  //
  // Guarded on the row already in hand so a pair with no subscription pays for
  // no extra query at all: the overwhelmingly common path stays exactly the two
  // statements it was before this feature existed.
  if (isPremiumHeadActive(match.userA) || isPremiumHeadActive(match.userB)) {
    const claimed = await settlePremiumSlots(matchId);
    if (claimed.length > 0) {
      const fresh = await loadTicketMatch(matchId);
      if (!fresh) return;
      match = fresh;
    }
  }

  // Both sides subscribe → the gate is already closed and nobody is being asked
  // for anything. The card still goes out, because it is the message that
  // carries the mutual reveal — but as a pure moment, with no keyboard: a
  // payment button pointing at a settled gate is the dead affordance §2.1
  // forbids, and the durable way back into the date is the My Date hub.
  const bothCovered = match.ticketPaidA !== null && match.ticketPaidB !== null;

  emitTicketEvent("ticket_offer_sent", { matchId });

  // This card carries the "It's mutual 🤍" reveal, so it is the moment the
  // falling-hearts effect belongs to — it's the first (and, with the gate on,
  // the only) message that tells each side the sympathy went both ways.
  const mutualEffectId = env.MESSAGE_EFFECT_MUTUAL_ID || undefined;

  const sends: Array<Promise<unknown>> = [];
  for (const user of [match.userA, match.userB]) {
    if (!isTelegramTarget(user.telegramId)) continue;
    sends.push(
      api.sendMessage(
        toTelegramChatId(user.telegramId),
        t(langOf(user), bothCovered ? "ticketCardCaptionPremium" : "ticketCardCaption"),
        {
          parse_mode: "Markdown",
          ...(bothCovered
            ? {}
            : { reply_markup: buildTicketKeyboard(matchId, langOf(user), user.theme) }),
          ...(mutualEffectId ? { message_effect_id: mutualEffectId } : {}),
        },
      ),
    );
  }
  await Promise.all(sends);

  // Only now — the Calendar must never overtake the reveal it follows. Same
  // rule §2.1 states for the pinned banner: a state change is not announced
  // before the message that describes it. `settlePremiumSlots` deliberately
  // leaves completion to this line for exactly that reason.
  if (bothCovered) await completeTicketGateAndUnlockScheduling(api, matchId);
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
 * The only two `ticketStatus` values a slot may still be claimed in. Every slot
 * CAS carries this, because `status` alone does NOT close the gate: the expiry
 * cron leaves the match `negotiating` and merely flips `ticketStatus` to
 * `expired`/`refunded` after opening the Calendar for FREE. Without it a stale
 * Mini App (the ticket card is permanent and re-openable) could still pay a day
 * later and claim a slot for a date that no longer costs anything — burning a
 * wallet ticket, or taking real Stars. An unclaimed Stars charge falls into the
 * existing `gate_refund_pending` path, so the money comes back either way.
 */
const OPEN_GATE_STATUSES = ["pending", "partial"] as const;

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
  starsLedger?: StarsGateLedgerRecord,
): Promise<{
  result: ApplyPaymentResult;
  claimedCount: number;
  ledgerReason?: string;
  surplusCount?: number;
}> {
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
  let claimAttempted = false;
  let ledgerReason: string | undefined;
  let surplusCount = 0;

  if (scope === "partner") {
    // Cover only the partner's slot — requires the actor to have already paid
    // their own ticket. Atomic claim on the partner's still-null slot.
    if (!myPaidAlready) {
      return { result: { ok: false, reason: "wrong-state" }, claimedCount: 0 };
    }
    if (!partnerPaidAlready) {
      claimAttempted = true;
      const claim = await claimTicketSlots(
        {
          where: {
            id: matchId,
            status: "negotiating",
            ticketStatus: { in: [...OPEN_GATE_STATUSES] },
            [partnerPaidField]: null,
          },
          data: { [partnerPaidField]: now, [paidForPartnerField]: true },
        },
        1,
        starsLedger,
      );
      claimedCount = claim.claimedCount;
      ledgerReason = claim.ledgerReason;
      surplusCount = claim.surplusCount;
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
    claimAttempted = true;
    const claim = await claimTicketSlots(
      {
        where: {
          id: matchId,
          status: "negotiating",
          ticketStatus: { in: [...OPEN_GATE_STATUSES] },
          [paidField]: null,
          // A stale "both" read must not overwrite a partner payment that landed
          // concurrently. Losing this stronger CAS causes the whole charge/spend
          // to be refunded by the caller.
          ...(coverPartner ? { [partnerPaidField]: null } : {}),
        },
        data,
      },
      coverPartner ? 2 : 1,
      starsLedger,
    );
    claimedCount = claim.claimedCount;
    ledgerReason = claim.ledgerReason;
    surplusCount = claim.surplusCount;
    if (claimedCount === 0) {
      if (starsLedger) {
        const fresh = await loadTicketMatch(matchId);
        if (
          fresh &&
          (ledgerReason === GATE_SETTLED_REASON || ledgerReason === GATE_SURPLUS_PENDING_REASON)
        ) {
          return {
            result: { ok: true, state: buildTicketStateView(fresh, side) },
            claimedCount: 0,
            ledgerReason,
            surplusCount,
          };
        }
        return {
          result: { ok: false, reason: "wrong-state" },
          claimedCount: 0,
          ...(ledgerReason ? { ledgerReason } : {}),
        };
      }
      // Lost the race or wrong state. Re-read; if our side is now paid it was a
      // concurrent duplicate — treat as success (idempotent).
      const fresh = await loadTicketMatch(matchId);
      if (!fresh) return { result: { ok: false, reason: "match-not-found" }, claimedCount: 0 };
      const sidePaidNow = (side === "A" ? fresh.ticketPaidA : fresh.ticketPaidB) !== null;
      if (!sidePaidNow) return { result: { ok: false, reason: "wrong-state" }, claimedCount: 0 };
      return { result: { ok: true, state: buildTicketStateView(fresh, side) }, claimedCount: 0 };
    }
    emitTicketEvent("ticket_paid", { matchId, side, scope, amountCents: amountForScope(scope, match.ticketPriceCents) });

  }

  if (starsLedger && claimAttempted && claimedCount === 0) {
    const fresh = await loadTicketMatch(matchId);
    if (
      fresh &&
      (ledgerReason === GATE_SETTLED_REASON || ledgerReason === GATE_SURPLUS_PENDING_REASON)
    ) {
      return {
        result: { ok: true, state: buildTicketStateView(fresh, side) },
        claimedCount: 0,
        ledgerReason,
        surplusCount,
      };
    }
    return {
      result: { ok: false, reason: "wrong-state" },
      claimedCount: 0,
      ...(ledgerReason ? { ledgerReason } : {}),
    };
  }

  // A newly paid Stars charge that found its requested slot already occupied
  // must be refunded. Wallet/mock redeliveries retain their older idempotent
  // behavior, but a distinct provider charge can never be silently accepted.
  if (starsLedger && !claimAttempted) {
    await prisma.ticketLedger.updateMany({
      where: { id: starsLedger.id, reason: GATE_PAYMENT_REASON },
      data: { reason: GATE_REFUND_PENDING_REASON },
    });
    return {
      result: { ok: false, reason: "wrong-state" },
      claimedCount: 0,
      ledgerReason: GATE_REFUND_PENDING_REASON,
    };
  }

  // Takt 1 — the payer just covered the partner's slot (the goodwill gesture):
  // confirm to HIM that it landed, so his attentiveness gets an immediate
  // acknowledgement instead of a silent settle. `partner` scope always covers
  // her; `both` covers her only when this call actually claimed 2 slots (she
  // hadn't already paid — otherwise `claimedCount` is 1 and it was just his own).
  const coveredPartnerNow =
    (scope === "partner" && claimedCount > 0) || (scope === "both" && claimedCount === 2);
  if (coveredPartnerNow && isTelegramTarget(me.telegramId)) {
    const peer = peerUser(match, side);
    const effectId = env.MESSAGE_EFFECT_TICKET_ID;
    await api
      .sendMessage(
        toTelegramChatId(me.telegramId),
        t(langOf(me), "ticketCoveredHerConfirm", { name: peer.firstName ?? "" }),
        effectId ? { message_effect_id: effectId } : {},
      )
      .catch(() => {});
  }

  // Recompute terminal state from fresh data.
  const after = await loadTicketMatch(matchId);
  if (!after) return { result: { ok: false, reason: "match-not-found" }, claimedCount };
  const bothPaid = after.ticketPaidA !== null && after.ticketPaidB !== null;

  // Settled ONE slot — their own — and the gate is still half-open. Until now
  // this produced no chat trace whatsoever: the Mini App jumped straight to the
  // cover offer, so closing it left the payer with nothing showing they had
  // paid, and left the peer with nothing at all — even though the line below
  // quietly resets HER deadline to 24h from this moment. The `claimedCount > 0`
  // guard is the same CAS that settled the slot, so each side hears this
  // exactly once per real payment; no extra idempotency column is needed.
  if (claimedCount > 0 && !coveredPartnerNow && !bothPaid) {
    const peer = peerUser(match, side);
    if (isTelegramTarget(me.telegramId)) {
      await api
        .sendMessage(toTelegramChatId(me.telegramId), t(langOf(me), "ticketGateWaiting"))
        .catch(() => {});
    }
    if (isTelegramTarget(peer.telegramId)) {
      await api
        .sendMessage(
          toTelegramChatId(peer.telegramId),
          t(langOf(peer), "ticketPeerTookTheirs", { name: me.firstName ?? "" }),
          { reply_markup: buildTicketKeyboard(matchId, langOf(peer), peer.theme) },
        )
        .catch(() => {});
    }
  }

  if (bothPaid && after.ticketStatus !== "completed") {
    await completeTicketGateAndUnlockScheduling(api, matchId);
  } else if (!bothPaid && after.ticketStatus === "pending") {
    // First payment → partial; give the second side a fresh window.
    await prisma.match.updateMany({
      where: {
        id: matchId,
        status: "negotiating",
        ticketStatus: "pending",
        OR: [{ ticketPaidA: null }, { ticketPaidB: null }],
      },
      data: { ticketStatus: "partial", ticketExpiresAt: ticketGateDeadline() },
    });
  }

  // The ticket card is permanent + untracked; the Mini App shows the live
  // "waiting / both secured / surprise" state, so there is no in-chat card to
  // edit here. The Calendar follows as its own message via startScheduling.
  const final = await loadTicketMatch(matchId);
  if (!final) return { result: { ok: false, reason: "match-not-found" }, claimedCount };
  return {
    result: { ok: true, state: buildTicketStateView(final, side) },
    claimedCount,
    ...(ledgerReason ? { ledgerReason } : {}),
    surplusCount,
  };
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

const GATE_PAYMENT_REASON = "gate_payment";
const GATE_PROCESSING_REASON = "gate_processing";
const GATE_SETTLED_REASON = "gate_settled";
const GATE_SURPLUS_PENDING_REASON = "gate_surplus_pending";
const GATE_REFUND_PENDING_REASON = "gate_refund_pending";
const GATE_REFUNDED_REASON = "gate_refunded";

interface StarsGateLedgerRecord {
  id: string;
  userId: string;
  matchId: string | null;
  reason: string;
  externalPaymentId: string | null;
  bundleSize: number | null;
}

type MatchUpdateManyArgs = Parameters<typeof prisma.match.updateMany>[0];

/** Atomically associate a Stars charge with the match slots it won. The ledger
 * outcome and slot CAS commit together, eliminating the crash window where a
 * redelivery could not distinguish its own settlement from another charge. */
async function claimTicketSlots(
  args: MatchUpdateManyArgs,
  slotsWhenClaimed: number,
  starsLedger?: StarsGateLedgerRecord,
): Promise<{ claimedCount: number; ledgerReason?: string; surplusCount: number }> {
  if (!starsLedger) {
    const claim = await prisma.match.updateMany(args);
    return { claimedCount: claim.count > 0 ? slotsWhenClaimed : 0, surplusCount: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const processing = await tx.ticketLedger.updateMany({
      where: { id: starsLedger.id, reason: GATE_PAYMENT_REASON },
      data: { reason: GATE_PROCESSING_REASON },
    });
    if (processing.count === 0) {
      const existing = await tx.ticketLedger.findUnique({
        where: { id: starsLedger.id },
        select: { reason: true, bundleSize: true },
      });
      if (!existing) throw new Error("Stars gate ledger disappeared during settlement");
      return {
        claimedCount: 0,
        ledgerReason: existing.reason,
        surplusCount:
          existing.reason === GATE_SURPLUS_PENDING_REASON ? (existing.bundleSize ?? 0) : 0,
      };
    }

    const claim = await tx.match.updateMany(args);
    const claimedCount = claim.count > 0 ? slotsWhenClaimed : 0;
    const requestedCount = starsLedger.bundleSize ?? slotsWhenClaimed;
    const surplus = Math.max(0, requestedCount - claimedCount);
    const nextReason =
      claimedCount === 0
        ? GATE_REFUND_PENDING_REASON
        : surplus > 0
          ? GATE_SURPLUS_PENDING_REASON
          : GATE_SETTLED_REASON;
    await tx.ticketLedger.updateMany({
      where: { id: starsLedger.id, reason: GATE_PROCESSING_REASON },
      data: {
        reason: nextReason,
        ...(surplus > 0 ? { bundleSize: surplus } : {}),
      },
    });
    return {
      claimedCount,
      ledgerReason: nextReason,
      surplusCount: surplus,
    };
  });
}

async function recordStarsGatePayment(input: {
  telegramId: bigint;
  matchId: string;
  scope: TicketScope;
  chargeId: string;
}): Promise<StarsGateLedgerRecord | null> {
  const payer = await prisma.user.findUnique({
    where: { telegramId: input.telegramId },
    select: { id: true },
  });
  if (!payer) return null;

  const existing = await prisma.ticketLedger.findUnique({
    where: { externalPaymentId: input.chargeId },
    select: {
      id: true,
      userId: true,
      matchId: true,
      reason: true,
      externalPaymentId: true,
      bundleSize: true,
    },
  });
  if (existing) {
    if (existing.userId !== payer.id || existing.matchId !== input.matchId) {
      throw new Error("Telegram charge id is already attached to another ticket payment");
    }
    return existing;
  }

  try {
    const record = await prisma.ticketLedger.create({
      data: {
        userId: payer.id,
        delta: 0,
        reason: GATE_PAYMENT_REASON,
        matchId: input.matchId,
        bundleSize: ticketsForScope(input.scope),
        amountStars: gateStarsForScope(input.scope),
        externalPaymentId: input.chargeId,
      },
      select: {
        id: true,
        userId: true,
        matchId: true,
        reason: true,
        externalPaymentId: true,
        bundleSize: true,
      },
    });
    // Founder ops feed. Only a genuinely NEW charge row reaches here — a
    // redelivery returns the `existing` row above — so the sale is announced
    // exactly once, at the moment Telegram confirmed the Stars moved.
    void notifyFounderPurchase({
      userId: payer.id,
      kind: "date_ticket",
      provider: "telegram_stars",
      amountStars: gateStarsForScope(input.scope),
      detail:
        input.scope === "both"
          ? "оба слота (заплатил за двоих)"
          : input.scope === "partner"
            ? "слот партнёра"
            : "свой слот",
      matchId: input.matchId,
      externalPaymentId: input.chargeId,
    });
    return record;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.ticketLedger.findUnique({
      where: { externalPaymentId: input.chargeId },
      select: {
        id: true,
        userId: true,
        matchId: true,
        reason: true,
        externalPaymentId: true,
        bundleSize: true,
      },
    });
    if (!raced || raced.userId !== payer.id || raced.matchId !== input.matchId) throw error;
    return raced;
  }
}

function isAlreadyRefundedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "description" in error
        ? String((error as { description?: unknown }).description ?? "")
        : String(error);
  return /already[^\n]*refund|refund[^\n]*already/i.test(text);
}

async function refundStarsLedgerRecord(
  api: Api<RawApi>,
  telegramId: bigint,
  record: StarsGateLedgerRecord,
  options: { allowSettled?: boolean } = {},
): Promise<boolean> {
  const chargeId = record.externalPaymentId;
  if (!chargeId) return false;
  if (record.reason === GATE_REFUNDED_REASON) return true;

  const claim = await prisma.ticketLedger.updateMany({
    where: {
      id: record.id,
      reason: {
        in: [
          GATE_PAYMENT_REASON,
          GATE_REFUND_PENDING_REASON,
          ...(options.allowSettled ? [GATE_SETTLED_REASON] : []),
        ],
      },
    },
    data: { reason: GATE_REFUND_PENDING_REASON },
  });
  if (claim.count === 0) {
    const current = await prisma.ticketLedger.findUnique({
      where: { id: record.id },
      select: { reason: true },
    });
    if (current?.reason === GATE_REFUNDED_REASON) return true;
    if (current?.reason !== GATE_REFUND_PENDING_REASON) return false;
  }

  try {
    await api.refundStarPayment(Number(telegramId), chargeId);
  } catch (error) {
    if (!isAlreadyRefundedError(error)) return false;
  }

  const settled = await prisma.ticketLedger.updateMany({
    where: {
      id: record.id,
      reason: {
        in: [GATE_PAYMENT_REASON, GATE_SETTLED_REASON, GATE_REFUND_PENDING_REASON],
      },
    },
    data: { reason: GATE_REFUNDED_REASON },
  });
  // Founder ops feed. Gated on the CAS actually flipping the row, so a
  // concurrent retry that lost the race doesn't announce the refund twice.
  if (settled.count > 0) {
    void notifyFounderPurchaseRefunded({
      userId: record.userId,
      kind: "date_ticket",
      reason: "гейт не закрылся — Stars вернулись плательщику",
      externalPaymentId: chargeId,
    });
  }
  return true;
}

async function creditStarsSurplus(
  record: StarsGateLedgerRecord,
  count: number,
): Promise<boolean> {
  const chargeId = record.externalPaymentId;
  if (!chargeId || !record.matchId || count <= 0) return false;
  try {
    await grantTickets({
      userId: record.userId,
      count,
      reason: "refund",
      matchId: record.matchId,
      externalPaymentId: `gate-surplus:${chargeId}`,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await prisma.ticketLedger.updateMany({
    where: { id: record.id, reason: GATE_SURPLUS_PENDING_REASON },
    data: { reason: GATE_SETTLED_REASON },
  });
  return true;
}

/** Retry durable Stars refunds/surplus credits. A payment row left unprocessed
 * for five minutes means the process died between recording the Telegram charge
 * and entering the atomic slot transaction, so it is safely refunded too. */
export async function retryPendingStarsGateRefunds(api: Api<RawApi>): Promise<number> {
  const abandonedBefore = new Date(Date.now() - 5 * 60_000);
  const pending = await prisma.ticketLedger.findMany({
    where: {
      externalPaymentId: { not: null },
      OR: [
        { reason: { in: [GATE_REFUND_PENDING_REASON, GATE_SURPLUS_PENDING_REASON] } },
        { reason: GATE_PAYMENT_REASON, createdAt: { lt: abandonedBefore } },
      ],
    },
    select: {
      id: true,
      userId: true,
      matchId: true,
      reason: true,
      externalPaymentId: true,
      bundleSize: true,
      user: { select: { telegramId: true } },
    },
    take: 200,
  });

  let adjusted = 0;
  for (const record of pending) {
    try {
      if (record.reason === GATE_SURPLUS_PENDING_REASON) {
        if (await creditStarsSurplus(record, record.bundleSize ?? 0)) adjusted += 1;
      } else if (await refundStarsLedgerRecord(api, record.user.telegramId, record)) {
        adjusted += 1;
      }
    } catch (error) {
      console.error(`[stars] failed to retry gate adjustment ledger=${record.id}:`, error);
    }
  }
  return adjusted;
}

/**
 * Telegram Stars path: settle the gate after Telegram confirms a Star payment
 * (the `successful_payment` update is the trust boundary, same role as the mock
 * `applyTicketPayment`). Identical settlement to `applyTicketPayment` — so it
 * inherits the §3.5b goodwill-cover confirm DM baked into `settleTicket` — MINUS
 * the famine single-ticket discount consume: that discount is USD-only and never
 * applies to a Stars purchase, so a Stars `self` payment must not burn it. Scope
 * `both`/`partner` male-only is enforced inside `settleTicket`.
 */
export async function applyStarsTicketPayment(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  scope: TicketScope,
  chargeId: string,
): Promise<ApplyPaymentResult> {
  const ledger = await recordStarsGatePayment({ telegramId, matchId, scope, chargeId });
  if (!ledger) {
    await api.refundStarPayment(Number(telegramId), chargeId).catch((error) => {
      console.error("[stars] gate payment has no payer row and could not be durably refunded:", error);
    });
    return { ok: false, reason: "wrong-state" };
  }
  if (ledger.reason === GATE_REFUNDED_REASON) {
    return { ok: false, reason: "wrong-state" };
  }
  if (ledger.reason === GATE_REFUND_PENDING_REASON) {
    await refundStarsLedgerRecord(api, telegramId, ledger);
    return { ok: false, reason: "wrong-state" };
  }
  if (ledger.reason === GATE_SURPLUS_PENDING_REASON) {
    await creditStarsSurplus(ledger, ledger.bundleSize ?? 0);
    const state = await getTicketState(telegramId, matchId);
    return state.ok ? { ok: true, state: state.state } : { ok: false, reason: state.reason };
  }
  if (ledger.reason === GATE_SETTLED_REASON) {
    const state = await getTicketState(telegramId, matchId);
    return state.ok ? { ok: true, state: state.state } : { ok: false, reason: state.reason };
  }

  const { result, ledgerReason, surplusCount = 0 } = await settleTicket(
    api,
    telegramId,
    matchId,
    scope,
    ledger,
  );
  const effectiveLedger = {
    ...ledger,
    reason: ledgerReason ?? ledger.reason,
    ...(ledgerReason === GATE_SURPLUS_PENDING_REASON ? { bundleSize: surplusCount } : {}),
  };
  if (!result.ok) {
    // Telegram already moved the Stars (this runs from `successful_payment`), but
    // nothing settled — the match left `negotiating` between the pre_checkout
    // approval and this callback (a reusable invoice link paid after the match
    // was cancelled / expired). Give the Stars back rather than silently keeping
    // them; mirrors the venue-change lost-race refund. Best-effort + idempotent:
    // a redelivery hits an already-refunded charge and is caught. `settleTicket`
    // returns `ok:true` for an idempotent duplicate, so this never refunds a
    // genuinely-settled payment.
    const refunded = await refundStarsLedgerRecord(api, telegramId, effectiveLedger);
    if (!refunded) {
      console.error("[stars] gate settle-failed refund queued", {
        matchId,
        telegramId: telegramId.toString(),
        chargeId,
      });
    }
    return result;
  }

  // Surplus guard. The Mini App no longer offers `both`/`partner` once she has
  // settled her own slot, and the invoice route refuses to mint one — but she
  // can still pay in the seconds between him opening a `both` invoice and
  // confirming it, in which case only his single slot is claimable and he has
  // paid the doubled price. Telegram can only refund a Stars charge in FULL
  // (never partially), so the overpaid slot is returned as a wallet ticket
  // instead — the same principle as the wallet path's surplus refund, and he
  // keeps the value. `externalPaymentId` makes it exactly-once, so a redelivered
  // `successful_payment` (which the slot CAS already no-ops) cannot mint a
  // second free ticket.
  if (ledgerReason === GATE_SURPLUS_PENDING_REASON && surplusCount > 0) {
    await creditStarsSurplus(effectiveLedger, surplusCount);
    console.info(
      `[stars] gate surplus refunded as ${surplusCount} ticket(s) user=${telegramId} ` +
        `match=${matchId} scope=${scope} charge=${chargeId}`,
    );
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

  // Goodwill cover fallback (§3.5b): if the male covered the partner's ticket
  // but she never opened the reveal before the gate completed, she'd otherwise
  // learn nothing (she may go straight to the Calendar). Send her the warm
  // "he covered your ticket ❤️" DM — the reveal delivered as a message, with a
  // button back to the ticket card — so the notification is guaranteed. We do
  // NOT stamp `partnerPaidSeenAt` here: his "she saw it" payoff still waits for a
  // genuine open (she can tap the button), keeping that read-receipt honest.
  const done = await loadTicketMatch(matchId);
  const coveredSide: Side | null = done
    ? done.paidForPartnerByA
      ? "B"
      : done.paidForPartnerByB
        ? "A"
        : null
    : null;
  // When he covered HER ticket, hold her Calendar back until she opens the
  // "he paid your ticket ❤️" reveal — she should feel the surprise before we
  // ask her to pick a time. Her card is delivered from `markPartnerPaidSeenAndNotify`
  // when she opens; the payer's Calendar still goes out now. If she raced ahead
  // and already saw it, don't defer.
  const deferHerCalendar = coveredSide !== null && done?.partnerPaidSeenAt == null;

  if (done && coveredSide && done.partnerPaidSeenAt === null && done.partnerPaidNudgedAt === null) {
    const claim = await prisma.match.updateMany({
      where: { id: matchId, partnerPaidNudgedAt: null },
      data: { partnerPaidNudgedAt: new Date() },
    });
    if (claim.count > 0) {
      const covered = selfUser(done, coveredSide);
      const payer = peerUser(done, coveredSide);
      if (isTelegramTarget(covered.telegramId)) {
        await api
          .sendMessage(
            toTelegramChatId(covered.telegramId),
            t(langOf(covered), "ticketPartnerPaidDm", { name: payer.firstName ?? "" }),
            // She was already covered — the button is "view your ticket", not "get".
            { reply_markup: buildTicketKeyboard(matchId, langOf(covered), covered.theme, "ticketViewButton") },
          )
          .catch(() => {});
      }
    }
  }

  // The persistent ticket card stays in chat untouched; the Calendar is sent as
  // a SEPARATE message that follows it. `calendarMessageId*` is NOT null here —
  // it holds the "accepted, waiting" receipt from before the gate, which is why
  // `afterTicketGate` makes `startScheduling` delete and resend rather than edit
  // it in place: an edit would put the Calendar above the ticket card, silently.
  // The same flag also makes the
  // Calendar card use a plain caption so it doesn't repeat the ticket card's
  // "It's mutual 🔥" celebration. When he covered her, HER card is skipped here
  // and delivered once she opens the reveal (see above). §3.5b.
  await startScheduling(api, matchId, {
    afterTicketGate: true,
    ...(deferHerCalendar && coveredSide ? { skipSide: coveredSide } : {}),
  });
}

async function refundPaidTicketSide(
  api: Api<RawApi>,
  match: TicketMatch,
  paidSide: Side,
): Promise<boolean> {
  const payer = selfUser(match, paidSide);
  const stars = await prisma.ticketLedger.findMany({
    where: {
      userId: payer.id,
      matchId: match.id,
      reason: {
        in: [
          GATE_PAYMENT_REASON,
          GATE_SETTLED_REASON,
          GATE_REFUND_PENDING_REASON,
          GATE_REFUNDED_REASON,
        ],
      },
      externalPaymentId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      matchId: true,
      reason: true,
      externalPaymentId: true,
      bundleSize: true,
    },
  });
  if (stars.length > 0) {
    let allRefunded = true;
    for (const record of stars) {
      const refunded = await refundStarsLedgerRecord(api, payer.telegramId, record, {
        allowSettled: true,
      });
      if (!refunded) allRefunded = false;
    }
    return allRefunded;
  }

  const walletSpend = await prisma.ticketLedger.findFirst({
    where: { userId: payer.id, matchId: match.id, reason: "spend_match", delta: { lt: 0 } },
    select: { id: true },
  });
  if (walletSpend) {
    try {
      await grantTickets({
        userId: payer.id,
        count: 1,
        reason: "refund",
        matchId: match.id,
        externalPaymentId: `wallet-expiry-refund:${match.id}:${payer.id}`,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return true;
  }

  const fallback = await refundTicketPayment({
    matchId: match.id,
    amountCents: match.ticketPriceCents,
  });
  return fallback.ok;
}

/**
 * A `partial` (or `pending`) ticket lapsed. Claim `refund_pending`, perform the
 * provider/wallet refund, and only then mark the row `refunded` and announce it.
 * Failed refunds stay retryable instead of being reported as successful.
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
  if (!paidSide) {
    const expired = await prisma.match.updateMany({
      where: { id: matchId, status: "negotiating", ticketStatus: { in: ["pending", "partial"] } },
      data: { ticketStatus: "expired", ticketExpiresAt: null },
    });
    if (expired.count === 0) return;
    await startScheduling(api, matchId, { afterTicketGate: true });
    return;
  }

  if (match.ticketStatus !== "refund_pending") {
    const claimed = await prisma.match.updateMany({
      where: { id: matchId, status: "negotiating", ticketStatus: { in: ["pending", "partial"] } },
      data: { ticketStatus: "refund_pending", ticketExpiresAt: null },
    });
    if (claimed.count === 0) return;
  }

  const refunded = await refundPaidTicketSide(api, match, paidSide);
  if (!refunded) throw new Error(`Ticket refund remains pending for match ${matchId}`);

  // Keep `refund_pending` through the scheduling handoff. If the Calendar send
  // fails, the next expiry tick retries the idempotent refund + scheduler path.
  await startScheduling(api, matchId, { afterTicketGate: true });

  const finalized = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating", ticketStatus: "refund_pending" },
    data: { ticketStatus: "refunded", ticketExpiresAt: null },
  });
  if (finalized.count === 0) return;

  emitTicketEvent("ticket_refunded", { matchId, side: paidSide });
  const payer = selfUser(match, paidSide);
  if (isTelegramTarget(payer.telegramId)) {
    await api.sendMessage(toTelegramChatId(payer.telegramId), t(langOf(payer), "ticketRefundedDm"));
  }
}
