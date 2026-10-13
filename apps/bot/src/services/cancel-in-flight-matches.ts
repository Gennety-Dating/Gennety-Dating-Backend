import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import { endCancelledDateDayActivities } from "./date-day-activity.js";
import { sendPushToUser } from "./push.js";
import { refundPrimeTimeForDeadMatch } from "./prime-time-purchase.js";
import { refreshStatusBanners } from "./status-banner-refresh.js";
import {
  applyTicketRefundsInTx,
  planMatchTicketRefunds,
  ticketRefundNoticeKey,
  type TicketRefundOutcome,
} from "./ticket-refund.js";

/**
 * The four "in-flight" match statuses — a live proposal, a scheduling
 * handshake, a venue negotiation, or a booked date. A user who leaves the pool
 * (freeze / hard delete) OR is removed by moderation (suspend / ban /
 * safety-investigation) must have ALL of these cancelled, so a partner is never
 * stranded — and, critically for safety, so an already-`scheduled` in-person
 * date with a flagged user does not proceed.
 *
 * This is the single owner of that cancellation so the freeze/delete path and
 * the moderation path can never drift apart on which statuses count (they did:
 * moderation previously cancelled only `proposed`/`negotiating`, leaving
 * `negotiating_venue`/`scheduled` dates live for banned users).
 */
export const IN_FLIGHT_MATCH_STATUSES = [
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
] as const;

export interface CancelledPartner {
  matchId: string;
  /**
   * The participant the cancellation was made on behalf of (the one leaving,
   * moderated, or blocking). Their account may already be gone by delivery.
   */
  actorUserId: string;
  partnerUserId: string;
  partnerTelegramId: bigint;
  partnerLanguage: Language;
  partnerPlatform: string;
  /**
   * The Date Tickets returned for this match (PRODUCT_SPEC §3.5b), credited
   * inside the caller's transaction, in the same commit as the cancellation.
   * Account deletion cascades the match row away on commit, and a `cancelled`
   * row is never revisited by any sweep — so a credit attempted after the
   * commit and lost (restart, DB error) could never be recovered. Covers BOTH
   * participants, not just the partner. Read by the delivery half only for the
   * notice text.
   */
  ticketRefunds: TicketRefundOutcome[];
}

interface CancelOptions {
  /** Abort the caller when a DB cancellation fails (used before hard delete). */
  strict?: boolean;
  /**
   * Accounts deleted in the caller's transaction: their own wallet goes with
   * the row, so no ticket is credited to them — their partner still is.
   */
  refundSkipUserIds?: readonly string[];
}

// `ticketLedger` — потому что план возвратов теперь сверяется с реестром:
// возвращается то, за что действительно платили, а не всё, что помечено
// оплаченным (Premium закрывает слот бесплатно той же отметкой).
type CancellationDb = Pick<typeof prisma, "match" | "ticketLedger" | "user">;

/**
 * Claim all cancellation state changes using the caller's DB client. Passing a
 * transaction client makes user moderation + scheduled-date cancellation one
 * atomic safety operation. No network calls or cross-transaction writes occur
 * here.
 */
/** The exact row shape both claim paths load. */
type ClaimableMatch = {
  id: string;
  userAId: string;
  userBId: string;
  userA: { telegramId: bigint; language: Language | null; platform: string };
  userB: { telegramId: bigint; language: Language | null; platform: string };
};

const CLAIMABLE_MATCH_SELECT = {
  id: true,
  userAId: true,
  userBId: true,
  userA: { select: { telegramId: true, language: true, platform: true } },
  userB: { select: { telegramId: true, language: true, platform: true } },
} as const;

/**
 * Cancel ONE already-loaded in-flight match on behalf of `userId` and describe
 * what the surviving partner is owed. Returns null when the row was no longer
 * in flight by the time the claim ran (someone else got there first).
 *
 * Extracted so the whole-user sweep below and the single-match block path
 * (`services/user-block.ts`) can never drift on the two things that are easy
 * to get subtly different: the status guard on the claiming write, and the
 * fact that the refund plan is read AFTER it inside the same transaction.
 */
async function claimOneMatch(
  match: ClaimableMatch,
  userId: string,
  db: CancellationDb,
  options: CancelOptions,
): Promise<CancelledPartner | null> {
  try {
    const claimed = await db.match.updateMany({
      where: {
        id: match.id,
        status: { in: [...IN_FLIGHT_MATCH_STATUSES] },
      },
      data: { status: "cancelled" },
    });
    if (claimed.count === 0) return null;
  } catch (err) {
    console.warn("[cancel-in-flight] match cancel failed:", err);
    if (options.strict) throw err;
    return null;
  }

  // Plan AND credit the refunds AFTER the cancelling write above, in the same
  // transaction: that write holds the match row lock, so the ticket-expiry
  // rail's own `negotiating`-guarded claim cannot interleave and decide to
  // refund the same slot, and the credit commits with the cancellation or not
  // at all. A failure here throws rather than being swallowed: inside a
  // Postgres transaction any failed statement aborts the whole transaction
  // anyway, and a cancellation that commits without its refund is exactly the
  // silent loss this replaces. Only the non-strict caller — no transaction, the
  // cancel above already committed on its own — keeps the old best-effort
  // behaviour, because there the cancellation is the safety-critical half.
  let ticketRefunds: TicketRefundOutcome[] = [];
  try {
    const plan = await planMatchTicketRefunds(match.id, db);
    ticketRefunds = await applyTicketRefundsInTx(db, plan, {
      ...(options.refundSkipUserIds ? { skipUserIds: options.refundSkipUserIds } : {}),
    });
  } catch (err) {
    if (options.strict) throw err;
    console.error(`[cancel-in-flight] ticket refund failed for match ${match.id}:`, err);
  }

  const isA = match.userAId === userId;
  const partnerUserId = isA ? match.userBId : match.userAId;
  const partner = isA ? match.userB : match.userA;
  return {
    matchId: match.id,
    actorUserId: userId,
    partnerUserId,
    partnerTelegramId: partner.telegramId,
    partnerLanguage: (partner.language ?? "en") as Language,
    partnerPlatform: partner.platform,
    ticketRefunds,
  };
}

export async function claimInFlightMatchCancellations(
  userId: string,
  db: CancellationDb = prisma,
  options: CancelOptions = {},
): Promise<CancelledPartner[]> {
  const matches = await db.match.findMany({
    where: {
      status: { in: [...IN_FLIGHT_MATCH_STATUSES] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: CLAIMABLE_MATCH_SELECT,
  });
  const cancelled: CancelledPartner[] = [];

  for (const match of matches) {
    const entry = await claimOneMatch(match, userId, db, options);
    if (entry) cancelled.push(entry);
  }

  return cancelled;
}

/**
 * Cancel ONE match by id, on behalf of a participant. The block path needs
 * exactly this and not the sweep above: blocking a partner from a match that
 * has already ended must not take down the LIVE date the blocker has with
 * somebody else.
 *
 * Returns null when the match does not exist, `userId` is not on it, or it was
 * never in flight — all three are ordinary outcomes here, because a block is
 * filed just as often on a finished date as on a live one.
 */
export async function claimMatchCancellation(
  matchId: string,
  userId: string,
  db: CancellationDb = prisma,
  options: CancelOptions = {},
): Promise<CancelledPartner | null> {
  const match = await db.match.findFirst({
    where: {
      id: matchId,
      status: { in: [...IN_FLIGHT_MATCH_STATUSES] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: CLAIMABLE_MATCH_SELECT,
  });
  if (!match) return null;
  return claimOneMatch(match, userId, db, options);
}

/** Run best-effort compensation and cross-platform delivery after DB commit. */
export async function deliverCancelledPartnerEffects(
  cancelled: readonly CancelledPartner[],
  api: Api<RawApi> | null,
): Promise<void> {
  for (const item of cancelled) {
    // Surfaces that were counting down to this date, for both sides. The
    // pinned banner would otherwise name a moment that no longer exists until
    // the next status tick, and the iOS lock-screen card until iOS's 12-hour
    // cap — the sweep that ends it only looks at `scheduled` rows, and after an
    // account deletion the row is gone altogether. Same pair of calls the
    // emergency-cancel rail makes.
    const participants = [item.partnerUserId, item.actorUserId];
    await endCancelledDateDayActivities(item.matchId, participants).catch((err: unknown) => {
      console.warn("[cancel-in-flight] date-day card end failed:", err);
    });
    if (api) {
      await refreshStatusBanners(api, participants).catch(() => {});
    }

    await applyEmergencyCancellationPeerBoost(item.partnerUserId).catch((err: unknown) => {
      console.warn("[cancel-in-flight] partner compensation failed:", err);
    });

    // The date isn't happening, so every paid ticket went back to whoever paid
    // for it — no fault-finding (PRODUCT_SPEC §3.5b) — inside the cancelling
    // transaction (`claimOneMatch`). Only the notice is left to deliver.
    const refunds = item.ticketRefunds;
    // The pass follows the ticket (§9.1): the date did not happen, so the Stars
    // spent on the evening band go back to whoever spent them. A band opened by
    // a subscription has no purchase row and is therefore a no-op.
    await refundPrimeTimeForDeadMatch(item.matchId).catch((err: unknown) => {
      console.warn("[prime-time] dead-match refund failed:", err);
    });

    const partnerRefund = refunds.find((r) => r.userId === item.partnerUserId);
    const partnerRefundKey = ticketRefundNoticeKey(partnerRefund?.refunded ?? 0);
    const partnerNotice = partnerRefundKey
      ? `${t(item.partnerLanguage, "freezePartnerNotice")}\n\n${t(item.partnerLanguage, partnerRefundKey)}`
      : t(item.partnerLanguage, "freezePartnerNotice");

    if (
      api &&
      item.partnerTelegramId > 0n &&
      (item.partnerPlatform === "telegram" || item.partnerPlatform === "both")
    ) {
      await api
        .sendMessage(Number(item.partnerTelegramId), partnerNotice)
        .catch((err: unknown) => {
          console.warn("[cancel-in-flight] partner notice failed:", err);
        });
    }

    if (item.partnerPlatform === "mobile" || item.partnerPlatform === "both") {
      await sendPushToUser(item.partnerUserId, {
        title: "Gennety",
        body: partnerNotice,
        data: { type: "match.cancelled", matchId: item.matchId },
      }).catch((err: unknown) => {
        console.warn("[cancel-in-flight] partner push failed:", err);
      });
    }

    // The other refunded side (a freezing user, a moderated user) gets no
    // notice from this rail at all — their own flow owns that copy — so a
    // silent wallet credit would go unnoticed. One short standalone line.
    for (const refund of refunds) {
      if (refund.userId === item.partnerUserId) continue;
      const key = ticketRefundNoticeKey(refund.refunded);
      if (!key) continue;
      const body = t(refund.language, key);

      if (
        api &&
        refund.telegramId > 0n &&
        (refund.platform === "telegram" || refund.platform === "both")
      ) {
        await api.sendMessage(Number(refund.telegramId), body).catch((err: unknown) => {
          console.warn("[cancel-in-flight] refund notice failed:", err);
        });
      }
      if (refund.platform === "mobile" || refund.platform === "both") {
        await sendPushToUser(refund.userId, {
          title: "Gennety",
          body,
          data: { type: "ticket.refunded", matchId: item.matchId },
        }).catch((err: unknown) => {
          console.warn("[cancel-in-flight] refund push failed:", err);
        });
      }
    }
  }
}

/**
 * Cancel every in-flight match `userId` is part of. For each cancelled match the
 * partner gets the same small emergency-cancel Elo/priority comp and a neutral
 * `freezePartnerNotice` DM used by the freeze path — neutral because there is
 * nothing to reveal (the blind-decision invariant doesn't apply) and because a
 * moderation cancellation must not leak that the other user was actioned.
 *
 * Status changes use a compare-and-set guard so a concurrent completion or
 * expiry can never be overwritten with `cancelled`, and the compensation is
 * applied at most once. Delivery is best-effort on every platform: Telegram
 * participants receive a DM and mobile participants receive an Expo push.
 *
 * @param api  The bot Api used to DM cancelled partners. Pass `null` to cancel
 *             + comp without sending any DM (e.g. when no bot Api is wired).
 * @returns    The partners that were notified/comped, for the caller's logging.
 */
export async function cancelInFlightMatchesForUser(
  userId: string,
  api: Api<RawApi> | null,
  options: CancelOptions = {},
): Promise<CancelledPartner[]> {
  const cancelled = await claimInFlightMatchCancellations(userId, prisma, options);
  await deliverCancelledPartnerEffects(cancelled, api);
  return cancelled;
}
