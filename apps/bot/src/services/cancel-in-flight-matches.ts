import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import { sendPushToUser } from "./push.js";

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
    select: {
      id: true,
      userAId: true,
      userBId: true,
      userA: { select: { telegramId: true, language: true, platform: true } },
      userB: { select: { telegramId: true, language: true, platform: true } },
    },
  });
  const cancelled: CancelledPartner[] = [];

  for (const match of matches) {
    try {
      const claimed = await db.match.updateMany({
        where: {
          id: match.id,
          status: { in: [...IN_FLIGHT_MATCH_STATUSES] },
        },
        data: { status: "cancelled" },
      });
      if (claimed.count === 0) continue;
    } catch (err) {
      console.warn("[cancel-in-flight] match cancel failed:", err);
      if (options.strict) throw err;
      continue;
    }

    const isA = match.userAId === userId;
    const partnerUserId = isA ? match.userBId : match.userAId;
    const partner = isA ? match.userB : match.userA;
    cancelled.push({
      matchId: match.id,
      partnerUserId,
      partnerTelegramId: partner.telegramId,
      partnerLanguage: (partner.language ?? "en") as Language,
      partnerPlatform: partner.platform,
    });
  }

  return cancelled;
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

    if (
      api &&
      item.partnerTelegramId > 0n &&
      (item.partnerPlatform === "telegram" || item.partnerPlatform === "both")
    ) {
      await api
        .sendMessage(
          Number(item.partnerTelegramId),
          t(item.partnerLanguage, "freezePartnerNotice"),
        )
        .catch((err: unknown) => {
          console.warn("[cancel-in-flight] partner notice failed:", err);
        });
    }

    if (item.partnerPlatform === "mobile" || item.partnerPlatform === "both") {
      await sendPushToUser(item.partnerUserId, {
        title: "Gennety",
        body: t(item.partnerLanguage, "freezePartnerNotice"),
        data: { type: "match.cancelled", matchId: item.matchId },
      }).catch((err: unknown) => {
        console.warn("[cancel-in-flight] partner push failed:", err);
      });
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
