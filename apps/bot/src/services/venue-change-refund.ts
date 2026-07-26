import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";

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
  status: true,
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
  return true;
}

export interface VenueChangeRefundSweepResult {
  scanned: number;
  refunded: number;
  stillFailing: number;
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
  const rows = await prisma.venueChangePurchase.findMany({
    where: {
      OR: [
        { status: VENUE_PURCHASE_REFUND_FAILED },
        { status: VENUE_PURCHASE_PROCESSING, createdAt: { lt: staleBefore } },
      ],
    },
    select: {
      id: true,
      status: true,
      externalPaymentId: true,
      user: { select: { telegramId: true, language: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  const result: VenueChangeRefundSweepResult = {
    scanned: rows.length,
    refunded: 0,
    stillFailing: 0,
  };

  for (const row of rows) {
    // A mobile-only user carries a synthetic negative telegramId and cannot hold
    // a Stars charge, so there is nothing to refund through this rail.
    if (row.user.telegramId <= 0n) continue;
    const target =
      row.status === VENUE_PURCHASE_PROCESSING
        ? VENUE_PURCHASE_REFUNDED_STALE
        : VENUE_PURCHASE_REFUNDED_RACE;
    const ok = await refundVenueChangePurchase(
      api,
      { id: row.id, status: row.status, externalPaymentId: row.externalPaymentId },
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
        `stillFailing=${result.stillFailing}`,
    );
  }
  return result;
}
