import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import { sendPushToUser } from "./push.js";
import { refundMatchTickets, type TicketRefundOutcome } from "./ticket-refund.js";
import { getMainBotApi } from "./main-bot-api.js";
import { refundPrimeTimeForDeadMatch } from "./prime-time-purchase.js";
import { refreshStatusBanners } from "./status-banner-refresh.js";

/**
 * Emergency cancellation of a `scheduled` date, shared by both surfaces
 * (PRODUCT_SPEC §Phase 4 → Emergency Protocol).
 *
 * Extracted from `handlers/date/emergency.ts` when the native client needed
 * the same action (iOS task 4.4). Everything irreversible lives here; the
 * callers own only their own way of asking and their own way of telling the
 * partner. That split matters because the two surfaces disagree about
 * delivery — Telegram quotes the reason verbatim into a chat, iOS has no chat
 * to quote into — and must NOT disagree about anything else.
 */

export interface EmergencyCancelOutcome {
  peerUserId: string;
  /** Trimmed and capped exactly as it will be shown to the partner. */
  reason: string;
  refunds: TicketRefundOutcome[];
}

export type EmergencyCancelResult =
  | { ok: true; outcome: EmergencyCancelOutcome }
  | {
      ok: false;
      /**
       * `date-started`: the agreed time has come. Emergency cancellation is a
       * way out of a date that is still ahead; once it has begun, "they didn't
       * show up" belongs to the T+24h did-you-meet question (PRODUCT_SPEC
       * §Phase 4), not to a rail that refunds both tickets.
       */
      error: "not-found" | "forbidden" | "wrong-state" | "date-started";
    };

/** Telegram already capped the forwarded text here; keep both rails identical. */
export const EMERGENCY_REASON_MAX_LENGTH = 1000;

/**
 * Is a date at `agreedTime` still ahead, i.e. may the emergency rail still
 * cancel it? The cut-off `cancelScheduledDate` enforces (A13-M20), exported so
 * the surfaces that OFFER the rail — the My Date hub's button, the menu
 * agent's cancel card — hide it on the same instant the service starts
 * refusing, instead of handing over a button that can only be turned down. A
 * row with no time is not a date this rail can reason about, so it is closed.
 */
export function emergencyCancelOpen(agreedTime: Date | null, now: Date): boolean {
  return agreedTime !== null && agreedTime.getTime() > now.getTime();
}

/**
 * Cancel the date and settle every consequence: the peer's priority boost and
 * the ticket refunds.
 *
 * The status write is a **compare-and-set** on `status: "scheduled"`, so two
 * clients racing (the partner cancelling from Telegram at the same moment)
 * produce one cancellation and one `wrong-state`, not two sets of refunds.
 *
 * **Only before the date begins (A13-M20).** A `scheduled` row stays
 * `scheduled` until the T+24h feedback prompt completes it, and the button that
 * starts this flow stays in the chat, so the cancel used to work for a whole day
 * after the date — refunding both tickets for an evening that had already
 * happened, and skipping the feedback that would have said so. No grace after
 * the start: the product already has a rail for "they didn't show up" (the
 * did-you-meet question), and a grace window here would quietly decide the
 * no-show refund question PRODUCT_SPEC leaves open. The cut-off rides the CAS
 * too, so a request read a second before the start cannot land after it.
 */
export async function cancelScheduledDate(input: {
  matchId: string;
  actorUserId: string;
  reason: string;
  now?: Date;
}): Promise<EmergencyCancelResult> {
  const reason = input.reason.trim().slice(0, EMERGENCY_REASON_MAX_LENGTH);
  const now = input.now ?? new Date();

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      emergencyCancelledBy: true,
      agreedTime: true,
    },
  });
  if (!match) return { ok: false, error: "not-found" };

  const isParticipant =
    input.actorUserId === match.userAId || input.actorUserId === match.userBId;
  if (!isParticipant) return { ok: false, error: "forbidden" };
  // A `scheduled` row always carries its time; one without is not a date this
  // rail can reason about, so it reads as the wrong state rather than a start.
  if (match.status !== "scheduled" || match.emergencyCancelledBy || !match.agreedTime) {
    return { ok: false, error: "wrong-state" };
  }
  if (!emergencyCancelOpen(match.agreedTime, now)) {
    return { ok: false, error: "date-started" };
  }

  const claimed = await prisma.match.updateMany({
    where: {
      id: match.id,
      status: "scheduled",
      emergencyCancelledBy: null,
      agreedTime: { gt: now },
    },
    data: {
      status: "cancelled",
      emergencyCancelledBy: input.actorUserId,
      emergencyReason: reason,
    },
  });
  if (claimed.count === 0) return { ok: false, error: "wrong-state" };

  // The pinned banner was counting down to THIS date (§2.1 mode "date") for
  // both sides — one of whom may be on the OTHER surface from whoever just
  // cancelled, which is exactly why this lives in the shared service rather
  // than in either caller. It falls back to the ordinary drop countdown now
  // instead of naming a moment that no longer exists for up to a minute.
  const api = getMainBotApi();
  if (api) {
    await refreshStatusBanners(api, [match.userAId, match.userBId]).catch(() => {});
  }

  const peerUserId = input.actorUserId === match.userAId ? match.userBId : match.userAId;
  await applyEmergencyCancellationPeerBoost(peerUserId).catch((err: unknown) => {
    console.warn("[emergency] peer boost failed:", err instanceof Error ? err.message : err);
  });

  // The date isn't happening, so every paid ticket goes back to its payer —
  // including the canceller's (PRODUCT_SPEC §3.5b): the penalty for flaking is
  // already Elo, and taking the money on top would make an honest cancellation
  // more expensive than a silent no-show.
  const refunds = await refundMatchTickets(match.id).catch((err: unknown) => {
    console.warn("[emergency] ticket refund failed:", err instanceof Error ? err.message : err);
    return [] as TicketRefundOutcome[];
  });


  // The pass follows the ticket (§9.1): the date did not happen, so the Stars
  // spent on the evening band go back to whoever spent them. A band opened by a
  // subscription has no purchase row and is therefore a no-op.
  await refundPrimeTimeForDeadMatch(match.id).catch((err: unknown) => {
    console.warn("[prime-time] dead-match refund failed:", err);
  });

  await notifyPeerByPush(peerUserId, match.id);

  return { ok: true, outcome: { peerUserId, reason, refunds } };
}

/**
 * Push the partner, whichever surface cancelled.
 *
 * This lives here rather than in a caller because it is a consequence of the
 * cancellation, not of who performed it — and because it was **missing**. The
 * Telegram handler carried a comment claiming "mobile peers see the
 * cancellation via the poll, plus a push notification dispatched separately";
 * no such push existed anywhere. A mobile-only partner learned that their date
 * was off only by opening the app.
 *
 * The verbatim reason deliberately does NOT ride the push. A cancellation
 * reason is someone else's free text landing on a lock screen: the Telegram
 * rail quotes it inside the chat, where the recipient chose to look, and the
 * native rail shows it in the app for the same reason. `sendPushToUser` is a
 * no-op for a user with no token, so this costs a Telegram-only pair nothing.
 */
async function notifyPeerByPush(peerUserId: string, matchId: string): Promise<void> {
  const peer = await prisma.user.findUnique({
    where: { id: peerUserId },
    select: { language: true },
  });
  const lang = (peer?.language ?? "en") as Language;
  await sendPushToUser(peerUserId, {
    title: t(lang, "emergencyPushTitle"),
    body: t(lang, "emergencyPushBody"),
    data: { type: "match.cancelled", matchId },
  }).catch(() => false);
}
