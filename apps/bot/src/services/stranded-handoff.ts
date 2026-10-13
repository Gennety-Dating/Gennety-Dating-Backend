import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { STRANDED_HANDOFF_GRACE_MS, t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { startScheduling } from "../handlers/matching/scheduler.js";
import { sendTicketOffer, ticketGateDeadline } from "../handlers/matching/ticket-gate.js";
import { updateEloScores } from "../utils/elo-calculator.js";
import { sendPushToUser } from "./push.js";
import { refreshStatusBanners } from "./status-banner-refresh.js";
import { pushReachable } from "./telegram-reach.js";

/**
 * Finish stage handoffs that were interrupted half-way.
 *
 * Two transitions are done as a write followed by a separate step, inside one
 * request, and nothing re-runs the second half if the process stops in between
 * (a deploy, a crash, a thrown error):
 *
 * 1. **Mutual accept.** `claimMatchDecision` commits the second "yes", then the
 *    caller flips `proposed → negotiating`. A row left with both decisions set
 *    and still `proposed` is excluded from the expiry sweep on purpose
 *    (`PAIR_NOT_BOTH_ACCEPTED` — a mutual match must not expire), is not a
 *    stranded dispatch (it was dispatched), and neither side can tap again (the
 *    decision is final). Both people sat in it for good, out of every drop by
 *    the single-live-match rule.
 *
 * 2. **Calendar after the gate.** The ticket gate moves to a terminal status
 *    (`completed` / `expired` / `refunded`) and clears its deadline, then
 *    `startScheduling` writes the grid. With tickets off there is no gate at
 *    all — the default `pending` with no deadline — and `startScheduling` is
 *    the only step. The venue time-lapse rail empties the grid and calls it
 *    again. A row left with no grid and no live gate is invisible to both
 *    sweeps that own `negotiating`: the stall chain skips an empty grid
 *    ("the gate has its own deadline"), and the ticket-expiry sweep only reads
 *    a live gate.
 *
 * Both are rare and both are permanent, so a slow sweep is enough. The grace
 * window keeps it off handoffs still in flight; every write below is the same
 * compare-and-set the original path uses, so a race with a late original
 * completion is a no-op for whichever runs second.
 */

export interface StrandedHandoffResult {
  mutualAccepts: number;
  calendarsOpened: number;
}

/** The gate statuses that still take payments (`OPEN_GATE_STATUSES` in the gate). */
const LIVE_GATE_STATUSES = ["pending", "partial"] as const;

export async function recoverStrandedHandoffs(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<StrandedHandoffResult> {
  const cutoff = new Date(now.getTime() - STRANDED_HANDOFF_GRACE_MS);
  const result: StrandedHandoffResult = { mutualAccepts: 0, calendarsOpened: 0 };

  const mutual = await prisma.match.findMany({
    where: {
      status: "proposed",
      acceptedByA: true,
      acceptedByB: true,
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      userA: { select: { id: true, platform: true, language: true } },
      userB: { select: { id: true, platform: true, language: true } },
    },
    take: 50,
  });
  for (const match of mutual) {
    try {
      // The same compare-and-set both decision paths use, deadline included:
      // a `negotiating` row behind the gate without one is the invisible state
      // (2) above.
      const transitioned = await prisma.match.updateMany({
        where: { id: match.id, status: "proposed", acceptedByA: true, acceptedByB: true },
        data: {
          status: "negotiating",
          ...(env.TICKET_FEATURE_ENABLED ? { ticketExpiresAt: ticketGateDeadline() } : {}),
        },
      });
      if (transitioned.count === 0) continue;
      console.warn(`[stranded-handoff] finished mutual accept for match=${match.id}`);
      result.mutualAccepts++;

      await updateEloScores(match.userAId, match.userBId, true, true).catch((err: unknown) => {
        console.warn(`[stranded-handoff] elo update failed for ${match.id}:`, err);
      });
      if (env.TICKET_FEATURE_ENABLED) await sendTicketOffer(api, match.id);
      else await startScheduling(api, match.id);
      await refreshStatusBanners(api, [match.userAId, match.userBId]).catch(() => {});
      // Telegram participants just got the ticket / Calendar card; app users
      // hear it the way the native decision path tells them.
      for (const user of [match.userA, match.userB]) {
        if (!pushReachable(user)) continue;
        const lang = (user.language ?? "en") as Language;
        await sendPushToUser(user.id, {
          title: "Gennety",
          body: t(lang, "matchBothAccepted"),
          data: { type: "match.both_accepted", matchId: match.id },
        }).catch(() => false);
      }
    } catch (err) {
      console.error(`[stranded-handoff] mutual accept recovery failed for ${match.id}:`, err);
    }
  }

  // `proposed_times` can be NULL as well as empty (see `startScheduling`), and
  // Prisma's `isEmpty` does not match NULL — hence the raw predicate.
  const gridless = await prisma.$queryRaw<{ id: string; ticket_status: string }[]>`
    SELECT id, ticket_status FROM matches
    WHERE status = 'negotiating'
      AND COALESCE(cardinality(proposed_times), 0) = 0
      AND updated_at < ${cutoff}
      AND ticket_status <> 'refund_pending'
      AND NOT (ticket_status IN ('pending', 'partial') AND ticket_expires_at IS NOT NULL)
    LIMIT 50
  `;
  for (const row of gridless) {
    // A `pending`/`partial` gate with no deadline is not a gate anyone can pay
    // into or the expiry sweep will ever close: it is the tickets-off default
    // (or a row from before the decision paths armed the deadline atomically).
    // Opening the calendar is the only exit; leaving it is a permanent lock.
    try {
      await startScheduling(api, row.id, {
        afterTicketGate: !(LIVE_GATE_STATUSES as readonly string[]).includes(row.ticket_status),
      });
      console.warn(`[stranded-handoff] opened calendar for match=${row.id}`);
      result.calendarsOpened++;
    } catch (err) {
      console.error(`[stranded-handoff] calendar recovery failed for ${row.id}:`, err);
    }
  }

  return result;
}
