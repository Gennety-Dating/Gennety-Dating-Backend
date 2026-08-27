/**
 * Rematch refunds and their durable retry (REMATCH_PRODUCT_SPEC.md, D1).
 *
 * Split out of `rematch.ts` so that module stays free of any Telegram `Api`
 * handle. Everything here touches the provider, and every function obeys one
 * rule: **we never record or announce a refund that did not actually happen.**
 * A failed `refundStarPayment` leaves the row in `refund_failed` for the hourly
 * sweep — the same discipline `ticket-expiry` follows for gate refunds.
 */

import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import {
  REMATCH_PROCESSING,
  REMATCH_REFUND_FAILED,
  type RematchRunResult,
} from "./rematch.js";
import { notifyFounderPurchaseRefunded } from "./founder-notify.js";

/**
 * Rows stuck in `processing` for longer than this are treated as abandoned —
 * the process died between "Stars moved" and the terminal write — and refunded.
 * Comfortably longer than a real run (a few seconds) so a slow-but-live run is
 * never refunded out from under itself.
 */
export const REMATCH_PROCESSING_STALE_MS = 5 * 60 * 1000;

/** Terminal statuses that mean "his Stars are back". */
const REFUNDED_STATUSES = [
  "refunded_no_candidate",
  "refunded_ineligible",
  "refunded_undelivered",
] as const;

/**
 * Map a failed run to the status its refund should land in, so the audit row
 * says WHY the money came back rather than just that it did.
 */
export function refundStatusForReason(reason: RematchRunResult["reason"]): string {
  return reason === "no_candidate" || reason === "create_failed"
    ? "refunded_no_candidate"
    : "refunded_ineligible";
}

/**
 * Refund one purchase and record the outcome.
 *
 * Returns true only when the provider actually returned the Stars. On failure
 * the row is parked in `refund_failed` with the error text and the caller must
 * NOT tell the user they were refunded.
 */
export async function refundRematchPurchase(
  api: Api<RawApi>,
  purchase: { id: string; externalPaymentId: string; status: string },
  telegramId: bigint,
  targetStatus: string,
): Promise<boolean> {
  try {
    await api.refundStarPayment(Number(telegramId), purchase.externalPaymentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[rematch] refund failed purchase=${purchase.id} charge=${purchase.externalPaymentId}: ${message}`,
    );
    await prisma.rematchPurchase
      .update({
        where: { id: purchase.id },
        data: {
          status: REMATCH_REFUND_FAILED,
          refundError: message.slice(0, 500),
          // Stamped on a FAILED attempt too, not only on a terminal one:
          // nothing reads this column for meaning, and it is what lets the
          // sweep's retry tier order by "least recently attempted" instead of
          // re-trying one permanently stuck row every hour forever.
          resolvedAt: new Date(),
        },
      })
      .catch(() => {});
    return false;
  }

  const settled = await prisma.rematchPurchase
    .update({
      where: { id: purchase.id },
      data: { status: targetStatus, resolvedAt: new Date(), refundError: null },
      select: { userId: true, amountStars: true, externalPaymentId: true },
    })
    .catch(() => null);
  // Founder ops feed — the purchase was announced the instant the Stars moved
  // (a Rematch refund can follow seconds later), so the reversal is announced
  // too rather than leaving a sale in the feed that no longer exists.
  if (settled) {
    void notifyFounderPurchaseRefunded({
      userId: settled.userId,
      kind: "rematch",
      amountStars: settled.amountStars,
      reason: targetStatus,
      externalPaymentId: settled.externalPaymentId,
    });
  }
  return true;
}

/**
 * The sweep's per-tick budget, split into two tiers on purpose.
 *
 * A single `OR` query ordered by `createdAt` head-of-line blocks: a row that
 * fails permanently (a deleted Telegram account, a charge Telegram will not
 * reverse) keeps its original `createdAt` forever, so it is always inside the
 * first page. Fifty such rows and the sweep re-fetches the same fifty every
 * hour and never reaches row fifty-one — a genuinely refundable purchase
 * behind them is never refunded, and the log says `stillFailing` rather than
 * anything that names the queue.
 *
 * So the two statuses stop competing for one budget. Only `refund_failed` can
 * grow without bound, and it now cannot crowd out a fresh stale row. The total
 * is unchanged, so this costs no extra load.
 */
const SWEEP_STALE_BUDGET = 40;
const SWEEP_RETRY_BUDGET = 10;

export interface RematchRefundSweepResult {
  scanned: number;
  refunded: number;
  stillFailing: number;
  /**
   * Rows the rail cannot reach at all (a synthetic negative `telegramId`).
   * Counted rather than dropped: without it a tick that touched nothing logs
   * `refunded=0 stillFailing=0`, which reads as "nothing was wrong" when what
   * happened is "nothing was attempted".
   */
  skipped: number;
}

/**
 * Hourly sweep: retry `refund_failed` rows and refund abandoned `processing`
 * rows. Registered only when `REMATCH_FEATURE_ENABLED`, mirroring how
 * `ticket-expiry` is registered only under `TICKET_FEATURE_ENABLED`.
 *
 * A user whose refund finally lands here is DM'd once, at that moment — which is
 * the first point at which the statement "your Stars were returned" is true.
 */
export async function sweepRematchRefunds(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<RematchRefundSweepResult> {
  const staleBefore = new Date(now.getTime() - REMATCH_PROCESSING_STALE_MS);
  // Fresh money first: a `processing` row is a charge that has been taken and
  // never resolved, so it is the one the user is actually owed right now.
  const [stale, retries] = await Promise.all([
    prisma.rematchPurchase.findMany({
      where: { status: REMATCH_PROCESSING, createdAt: { lt: staleBefore } },
      select: {
      id: true,
      status: true,
      externalPaymentId: true,
      userId: true,
      user: { select: { telegramId: true, language: true } },
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_STALE_BUDGET,
    }),
    prisma.rematchPurchase.findMany({
      where: { status: REMATCH_REFUND_FAILED },
      select: {
      id: true,
      status: true,
      externalPaymentId: true,
      userId: true,
      user: { select: { telegramId: true, language: true } },
      },
      // `resolvedAt` is stamped on every attempt, successful or not, so a row
      // that keeps failing sinks behind rows tried longer ago and the retry
      // tier rotates instead of re-trying one stuck head forever. Nulls first:
      // a row that failed before this became true has never been tried under
      // the rotation, so it goes to the front once.
      orderBy: { resolvedAt: { sort: "asc", nulls: "first" } },
      take: SWEEP_RETRY_BUDGET,
    }),
  ]);
  const rows = [...stale, ...retries];

  const result: RematchRefundSweepResult = {
    scanned: rows.length,
    refunded: 0,
    stillFailing: 0,
    skipped: 0,
  };

  for (const row of rows) {
    // A mobile-only user carries a synthetic negative telegramId and cannot hold
    // a Stars charge, so there is nothing to refund through this rail.
    if (row.user.telegramId <= 0n) {
      result.skipped++;
      continue;
    }
    // An abandoned `processing` row never learned why it failed, so it settles
    // as `refunded_ineligible` — the neutral "we couldn't complete it" bucket.
    const target =
      row.status === REMATCH_PROCESSING ? "refunded_ineligible" : "refunded_no_candidate";
    const ok = await refundRematchPurchase(api, row, row.user.telegramId, target);
    if (!ok) {
      result.stillFailing++;
      continue;
    }
    result.refunded++;
    const lang = (row.user.language ?? "en") as Language;
    await api
      .sendMessage(Number(row.user.telegramId), t(lang, "rematchRefunded", {}))
      .catch(() => {});
  }

  if (result.scanned > 0) {
    console.log(
      `[rematch-refund] scanned=${result.scanned} refunded=${result.refunded} stillFailing=${result.stillFailing} skipped=${result.skipped}`,
    );
  }
  return result;
}

/** Exported for tests / admin tooling: statuses that mean the money is back. */
export { REFUNDED_STATUSES };
