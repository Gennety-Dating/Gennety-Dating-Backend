import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import { sendPushToUser } from "./push.js";
import {
  applyTicketRefunds,
  planMatchTicketRefunds,
  ticketRefundNoticeKey,
  type TicketRefundCredit,
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
  partnerUserId: string;
  partnerTelegramId: bigint;
  partnerLanguage: Language;
  partnerPlatform: string;
  /**
   * Who is owed a Date Ticket back for this match (PRODUCT_SPEC §3.5b). Planned
   * here, inside the caller's transaction, because account deletion cascades
   * the match row away on commit — a post-commit lookup would find nothing and
   * the surviving partner would silently lose a ticket they paid for. Covers
   * BOTH participants, not just the partner.
   */
  ticketRefunds: TicketRefundCredit[];
}

interface CancelOptions {
  /** Abort the caller when a DB cancellation fails (used before hard delete). */
  strict?: boolean;
}

type CancellationDb = Pick<typeof prisma, "match">;

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

  // Read the refund plan AFTER the cancelling write above, in the same
  // transaction: that write holds the match row lock, so the ticket-expiry
  // rail's own `negotiating`-guarded claim cannot interleave and decide to
  // refund the same slot.
  let ticketRefunds: TicketRefundCredit[] = [];
  try {
    ticketRefunds = await planMatchTicketRefunds(match.id, db);
  } catch (err) {
    // A refund plan is never worth failing the cancellation over — the
    // cancellation is the safety-critical half.
    console.warn("[cancel-in-flight] ticket refund plan failed:", err);
  }

  const isA = match.userAId === userId;
  const partnerUserId = isA ? match.userBId : match.userAId;
  const partner = isA ? match.userB : match.userA;
  return {
    matchId: match.id,
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
    await applyEmergencyCancellationPeerBoost(item.partnerUserId).catch((err: unknown) => {
      console.warn("[cancel-in-flight] partner compensation failed:", err);
    });

    // The date isn't happening, so every paid ticket goes back to whoever paid
    // for it — no fault-finding (PRODUCT_SPEC §3.5b). Post-commit by design: on
    // hard delete the leaver's row is already gone and is skipped, while the
    // partner is still refunded.
    const refunds = await applyTicketRefunds(item.ticketRefunds).catch((err: unknown) => {
      console.warn("[cancel-in-flight] ticket refund failed:", err);
      return [];
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
