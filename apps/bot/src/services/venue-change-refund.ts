import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { notifyFounderPurchaseRefunded } from "./founder-notify.js";

/**
 * Venue-change (§3.7b) Stars refunds and their durable retry.
 *
 * Split out of `handlers/matching/venue-change.ts` so the settle path can stay
 * focused on the swap itself, and so the sweep can be registered as its own
 * cron. Everything here follows the same rule as `rematch-refund.ts`:
 * **we never record or announce a refund that did not actually happen.** A
 * failed `refundStarPayment` leaves the row in `refund_failed` for the hourly
 * sweep to retry.
 *
 * Why this module exists at all: before it, a venue-change payment that could
 * not be settled was refunded with a fire-and-forget
 * `.catch(err => console.error(...))` and the charge id was never persisted, so
 * a failed refund lost the user's Stars with no row anywhere to reconcile from.
 */

/** Stars moved; written before the settle CAS. */
export const VENUE_PURCHASE_PROCESSING = "processing";
/** The swap was claimed and both sides notified. */
export const VENUE_PURCHASE_SETTLED = "settled";
/** A second/racing charge could not claim the swap; Stars returned. */
export const VENUE_PURCHASE_REFUNDED_RACE = "refunded_race";
/** Abandoned mid-settle (process died); Stars returned by the sweep. */
export const VENUE_PURCHASE_REFUNDED_STALE = "refunded_stale";
/** The refund API call failed; the sweep owns this row until it flips. */
export const VENUE_PURCHASE_REFUND_FAILED = "refund_failed";

/**
 * Rows stuck in `processing` for longer than this are treated as abandoned —
 * the process died between "Stars moved" and the terminal write — and refunded.
 * Comfortably longer than a real settle (a few hundred ms plus two DMs) so a
 * slow-but-live settle is never refunded out from under itself.
 */
export const VENUE_PROCESSING_STALE_MS = 5 * 60 * 1000;

/** The columns the settle path and the sweep both need. */
export const VENUE_PURCHASE_SELECT = {
  id: true,
  userId: true,
  status: true,
  amountStars: true,
  externalPaymentId: true,
} satisfies Prisma.VenueChangePurchaseSelect;

export type VenueChangePurchaseRecord = Prisma.VenueChangePurchaseGetPayload<{
  select: typeof VENUE_PURCHASE_SELECT;
}>;

/**
 * Refund one purchase and record the outcome.
 *
 * Returns true only when Telegram actually returned the Stars. On failure the
 * row is parked in `refund_failed` with the error text, and the caller must NOT
 * tell the user they were refunded.
 */
export async function refundVenueChangePurchase(
  api: Api<RawApi>,
  purchase: VenueChangePurchaseRecord,
  telegramId: bigint,
  targetStatus: string,
): Promise<boolean> {
  try {
    await api.refundStarPayment(Number(telegramId), purchase.externalPaymentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[venue-change-refund] refund failed purchase=${purchase.id} ` +
        `charge=${purchase.externalPaymentId}: ${message}`,
    );
    await prisma.venueChangePurchase
      .update({
        where: { id: purchase.id },
        data: {
          status: VENUE_PURCHASE_REFUND_FAILED,
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

  await prisma.venueChangePurchase
    .update({
      where: { id: purchase.id },
      data: { status: targetStatus, resolvedAt: new Date(), refundError: null },
    })
    .catch(() => {});
  // Founder ops feed — keeps the DM honest: the purchase was announced when
  // the Stars moved, so the reversal has to be announced too.
  void notifyFounderPurchaseRefunded({
    userId: purchase.userId,
    kind: "venue_change",
    amountStars: purchase.amountStars,
    reason: targetStatus,
    externalPaymentId: purchase.externalPaymentId,
  });
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

export interface VenueChangeRefundSweepResult {
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
 * rows. Registered only when `VENUE_CHANGE_FEATURE_ENABLED`, mirroring how
 * `rematch-refund` is registered only under `REMATCH_FEATURE_ENABLED`.
 *
 * The user is DM'd once, at the moment the refund actually lands — which is the
 * first point at which "your Stars were returned" is a true statement.
 */
export async function sweepVenueChangeRefunds(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<VenueChangeRefundSweepResult> {
  const staleBefore = new Date(now.getTime() - VENUE_PROCESSING_STALE_MS);
  // Fresh money first: a `processing` row is a charge that has been taken and
  // never resolved, so it is the one the user is actually owed right now.
  const [stale, retries] = await Promise.all([
    prisma.venueChangePurchase.findMany({
      where: { status: VENUE_PURCHASE_PROCESSING, createdAt: { lt: staleBefore } },
      select: {
      id: true,
      userId: true,
      status: true,
      amountStars: true,
      externalPaymentId: true,
      user: { select: { telegramId: true, language: true } },
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_STALE_BUDGET,
    }),
    prisma.venueChangePurchase.findMany({
      where: { status: VENUE_PURCHASE_REFUND_FAILED },
      select: {
      id: true,
      userId: true,
      status: true,
      amountStars: true,
      externalPaymentId: true,
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

  const result: VenueChangeRefundSweepResult = {
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
    const target =
      row.status === VENUE_PURCHASE_PROCESSING
        ? VENUE_PURCHASE_REFUNDED_STALE
        : VENUE_PURCHASE_REFUNDED_RACE;
    const ok = await refundVenueChangePurchase(
      api,
      {
        id: row.id,
        userId: row.userId,
        status: row.status,
        amountStars: row.amountStars,
        externalPaymentId: row.externalPaymentId,
      },
      row.user.telegramId,
      target,
    );
    if (!ok) {
      result.stillFailing++;
      continue;
    }
    result.refunded++;
    const lang = (row.user.language ?? "en") as Language;
    await api
      .sendMessage(Number(row.user.telegramId), t(lang, "venueChangeRefunded"))
      .catch(() => {});
  }

  if (result.scanned > 0) {
    console.log(
      `[venue-change-refund] scanned=${result.scanned} refunded=${result.refunded} ` +
        `stillFailing=${result.stillFailing} skipped=${result.skipped}`,
    );
  }
  return result;
}
