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
}

interface CancelOptions {
  /** Abort the caller when a DB cancellation fails (used before hard delete). */
  strict?: boolean;
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
  const matches = await prisma.match.findMany({
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
      const claimed = await prisma.match.updateMany({
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
    const partnerLanguage = (partner.language ?? "en") as Language;

    await applyEmergencyCancellationPeerBoost(partnerUserId);

    if (
      api &&
      partner.telegramId > 0n &&
      (partner.platform === "telegram" || partner.platform === "both")
    ) {
      await api
        .sendMessage(Number(partner.telegramId), t(partnerLanguage, "freezePartnerNotice"))
        .catch((err: unknown) => {
          console.warn("[cancel-in-flight] partner notice failed:", err);
        });
    }

    if (partner.platform === "mobile" || partner.platform === "both") {
      await sendPushToUser(partnerUserId, {
        title: "Gennety",
        body: t(partnerLanguage, "freezePartnerNotice"),
        data: { type: "match.cancelled", matchId: match.id },
      }).catch((err: unknown) => {
        console.warn("[cancel-in-flight] partner push failed:", err);
      });
    }

    cancelled.push({
      matchId: match.id,
      partnerUserId,
      partnerTelegramId: partner.telegramId,
      partnerLanguage,
    });
  }

  return cancelled;
}
