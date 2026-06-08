import { prisma } from "@gennety/db";
import type { TranslationKey } from "@gennety/shared";

/**
 * Transport-agnostic pieces of the match Accept/Decline state machine, shared
 * by the Telegram handler (`handlers/matching/decision.ts`) and the mobile
 * endpoint (`public/matches-service.ts`).
 *
 * Both surfaces MUST resolve a decision identically — the audit (H1) found the
 * two had diverged: the mobile path cancelled on a first decline (breaking the
 * blind-decision invariant), skipped Elo, skipped the accepted-side
 * compensation, and left cross-platform matches stuck in `proposed`. Keeping
 * the rules here means there is one source of truth; each surface only differs
 * in how it renders the resulting notifications (Telegram DM vs Expo push).
 */

export type DecisionSide = "A" | "B";

/**
 * Pick the reveal message shown to a user once BOTH sides have decided.
 *
 * `userAccepted` / `peerAccepted` are from the reader's point of view.
 * `acceptedSidePriorityBoosted` is only meaningful when the reader accepted
 * but the peer declined — they get a softer, "we boosted your priority"
 * variant.
 */
export function outcomeRevealKey(
  userAccepted: boolean,
  peerAccepted: boolean,
  acceptedSidePriorityBoosted: boolean,
): TranslationKey {
  if (userAccepted && !peerAccepted) {
    return acceptedSidePriorityBoosted
      ? "matchAcceptedPeerDeclinedPriority"
      : "matchAcceptedPeerDeclined";
  }
  return peerAccepted ? "matchPeerWasAccepted" : "matchPeerWasDeclined";
}

/**
 * Compensate the user who accepted a match their partner then declined (or
 * ghosted): bump standby/priority so the next weekly batch favours them.
 * Idempotency is the caller's job — this unconditionally increments.
 *
 * Returns whether the boost was applied (drives the softer reveal copy).
 * Best-effort: a failure logs and returns `false` rather than aborting the
 * decision flow.
 */
export async function boostAcceptedSidePriority(userId: string): Promise<boolean> {
  try {
    await prisma.profile.updateMany({
      where: { userId },
      data: {
        standbyCount: { increment: 1 },
        missedWeeks: { increment: 1 },
        lastMissedAt: new Date(),
      },
    });
    return true;
  } catch (err) {
    console.warn(
      "[match-decision] accepted-side priority boost failed:",
      (err as Error).message,
    );
    return false;
  }
}
