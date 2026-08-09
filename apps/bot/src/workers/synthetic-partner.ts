import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { applyMatchDecision } from "../public/matches-service.js";

/**
 * The other side of a synthetic test match (PRODUCT_SPEC §3.1c).
 *
 * A synthetic profile exists to give a real friends-and-family tester an
 * anketa to look at when the real pool has nobody left to offer. It always
 * declines, and that rule is the feature's own safety mechanism rather than a
 * limitation: a mutual accept would open the §3.5b Date Ticket gate and invite
 * a real person to spend real Telegram Stars on a meeting that cannot happen.
 * Declining is what keeps money out of the test.
 *
 * ## When it answers
 *
 * Only after the human has committed, and never before
 * `SYNTHETIC_DECLINE_DELAY_MS` has elapsed since dispatch.
 *
 * "After the human" is what makes the §3.4 blind-decision invariant trivially
 * safe here — there is no window in which the product knows an answer the user
 * has not earned — and it also makes the test better: a tester who accepts
 * sits in the genuine waiting state, sees the §3.6b peer-wait shimmer, and
 * then gets the real mixed-outcome reveal. A synthetic that answered first
 * would collapse all of that into a nudge.
 *
 * The delay is measured from `Match.dispatchedAt` rather than from the human's
 * answer because the schema carries no timestamp for the latter:
 * `acceptedByA/B` are booleans, and `peerWaitStartedAt*` belongs to
 * `workers/peer-wait-shimmer.ts` under a single-writer rule (and is not
 * written at all when `PEER_WAIT_TICK_MS=0`). Combined with the "human has
 * answered" condition, an answer from dispatch is a floor on the reply, which
 * is exactly the intent.
 *
 * ## What it deliberately does NOT do
 *
 * Nothing when the human stays silent. That match belongs to the ordinary
 * expiry cron, which shows the tester the real expiry card — with the
 * behavioural consequences stripped out one level down
 * (`services/match-expiry.ts`).
 *
 * It also runs no logic of its own: the decline goes through
 * `applyMatchDecision`, the same production entry point a real partner's
 * client would call, so the Elo guard, the outcome reveals, the banner refresh
 * and the suppressed Rematch upsell all behave identically to a real decline.
 * The demo puppet uses the same function for the same reason.
 */

export interface SyntheticPartnerResult {
  /** Live proposals with a synthetic side, before any filtering. */
  scanned: number;
  /** Declines actually committed this tick. */
  declined: number;
  /** Waiting on the human, or still inside the hold window. */
  pending: number;
  /** `applyMatchDecision` refused (row already resolved by a race). */
  refused: number;
}

export interface SyntheticPartnerOptions {
  now?: Date;
  /** Overrides `SYNTHETIC_DECLINE_DELAY_MS`; used by tests. */
  delayMs?: number;
}

export async function syntheticPartnerTick(
  options: SyntheticPartnerOptions = {},
): Promise<SyntheticPartnerResult> {
  const result: SyntheticPartnerResult = {
    scanned: 0,
    declined: 0,
    pending: 0,
    refused: 0,
  };
  if (!env.SYNTHETIC_FILL_ENABLED) return result;

  const now = options.now ?? new Date();
  const delayMs = options.delayMs ?? env.SYNTHETIC_DECLINE_DELAY_MS;

  // Bounded by the single-live-match invariant: a `proposed` row exists only
  // for a pair that currently holds one, so this set is the live pool rather
  // than the historical table.
  const candidates = await prisma.match.findMany({
    where: {
      status: "proposed",
      dispatchedAt: { not: null },
      OR: [
        { userA: { syntheticAt: { not: null } } },
        { userB: { syntheticAt: { not: null } } },
      ],
    },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      acceptedByA: true,
      acceptedByB: true,
      dispatchedAt: true,
      userA: { select: { syntheticAt: true } },
      userB: { select: { syntheticAt: true } },
    },
  });

  result.scanned = candidates.length;

  for (const match of candidates) {
    const syntheticIsA = match.userA.syntheticAt !== null;
    // Both sides synthetic should be unreachable — `previewSyntheticFill`
    // refuses to build such a pair — but a hand-seeded row could produce one,
    // and answering on behalf of both would be a match nobody ever saw.
    if (syntheticIsA && match.userB.syntheticAt !== null) continue;

    const syntheticAnswered = syntheticIsA ? match.acceptedByA : match.acceptedByB;
    const humanAnswered = syntheticIsA ? match.acceptedByB : match.acceptedByA;
    if (syntheticAnswered !== null) continue;

    if (humanAnswered === null) {
      result.pending += 1;
      continue;
    }
    if (now.getTime() - match.dispatchedAt!.getTime() < delayMs) {
      result.pending += 1;
      continue;
    }

    const syntheticUserId = syntheticIsA ? match.userAId : match.userBId;
    try {
      const decided = await applyMatchDecision(match.id, syntheticUserId, "decline");
      // `applyMatchDecision` answers `null` rather than throwing when the row
      // is no longer `proposed`. Swallowing that would make a permanently
      // stuck match look exactly like a healthy one, which is the failure the
      // demo driver's own `refused(...)` accounting exists to prevent.
      if (decided) result.declined += 1;
      else result.refused += 1;
    } catch (err) {
      result.refused += 1;
      console.warn(
        `[synthetic-partner] decline failed for matchId=${match.id}:`,
        (err as Error).message,
      );
    }
  }

  if (result.declined > 0 || result.refused > 0) {
    console.log(
      `[synthetic-partner] scanned=${result.scanned} declined=${result.declined} ` +
        `pending=${result.pending} refused=${result.refused}`,
    );
  }

  return result;
}
