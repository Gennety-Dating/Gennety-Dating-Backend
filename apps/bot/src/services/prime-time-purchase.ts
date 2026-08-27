import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import { buildPrimeInvoicePayload, t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { notifyFounderPurchase, notifyFounderPurchaseRefunded } from "./founder-notify.js";
import { isTelegramTarget } from "../utils/telegram-target.js";
import { getMainBotApi } from "./main-bot-api.js";

/**
 * The paid Prime Time pass (PRIME_TIME_PRODUCT_SPEC.md §9) — settle, refund,
 * and the durable retry behind both.
 *
 * Same invariant as every other Stars rail in this product, and it is the whole
 * reason this module exists rather than a `.catch(console.error)` at the call
 * site: **money either changes something or comes back, never neither.** A
 * refund that fails is parked in `refund_failed` for the hourly sweep and is
 * NEVER announced to the user as completed.
 */

export const PRIME_PURCHASE_PROCESSING = "processing";
export const PRIME_PURCHASE_SETTLED = "settled";
/** Both sides paid at once; the loser of the CAS gets their Stars back. */
export const PRIME_PURCHASE_REFUNDED_RACE = "refunded_race";
/** Abandoned mid-settle (the process died); returned by the sweep. */
export const PRIME_PURCHASE_REFUNDED_STALE = "refunded_stale";
/** The date never happened (§9.1). */
export const PRIME_PURCHASE_REFUNDED_MATCH_DIED = "refunded_match_died";
export const PRIME_PURCHASE_REFUND_FAILED = "refund_failed";

/**
 * Comfortably longer than a real settle (a CAS plus one DM), so a slow-but-live
 * settle is never refunded out from under itself.
 */
export const PRIME_PROCESSING_STALE_MS = 5 * 60 * 1000;

export const PRIME_PURCHASE_SELECT = {
  id: true,
  userId: true,
  status: true,
  amountStars: true,
  externalPaymentId: true,
} satisfies Prisma.PrimeTimePurchaseSelect;

export type PrimeTimePurchaseRecord = Prisma.PrimeTimePurchaseGetPayload<{
  select: typeof PRIME_PURCHASE_SELECT;
}>;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Refund one purchase and record what actually happened.
 *
 * Returns true only when Telegram really returned the Stars — the caller must
 * not tell the user otherwise on a false.
 */
export async function refundPrimeTimePurchase(
  api: Api<RawApi>,
  purchase: PrimeTimePurchaseRecord,
  telegramId: bigint,
  targetStatus: string,
): Promise<boolean> {
  try {
    await api.refundStarPayment(Number(telegramId), purchase.externalPaymentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[prime-time-refund] refund failed purchase=${purchase.id} ` +
        `charge=${purchase.externalPaymentId}: ${message}`,
    );
    await prisma.primeTimePurchase
      .update({
        where: { id: purchase.id },
        data: {
          status: PRIME_PURCHASE_REFUND_FAILED,
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

  await prisma.primeTimePurchase
    .update({
      where: { id: purchase.id },
      data: { status: targetStatus, resolvedAt: new Date(), refundError: null },
    })
    .catch(() => {});
  // The sale was announced in the founder feed when the Stars moved, so the
  // reversal has to be announced too — otherwise the DM carries revenue that
  // no longer exists.
  void notifyFounderPurchaseRefunded({
    userId: purchase.userId,
    kind: "prime_time",
    amountStars: purchase.amountStars,
    reason: targetStatus,
    externalPaymentId: purchase.externalPaymentId,
  });
  return true;
}

/**
 * Mint the Stars invoice. Empty provider token + `XTR` is the whole of what a
 * Telegram Stars invoice needs — no merchant account, same as every other
 * Stars rail here.
 */
export async function createPrimeInvoiceLink(
  api: Api<RawApi>,
  lang: Language,
  matchId: string,
): Promise<string> {
  return api.createInvoiceLink(
    t(lang, "primeInvoiceTitle"),
    t(lang, "primeInvoiceDesc"),
    buildPrimeInvoicePayload(matchId),
    "",
    "XTR",
    [{ label: t(lang, "primeInvoiceLabel"), amount: env.PRIME_TIME_STARS }],
  );
}

export interface PrimeTimeSettleResult {
  ok: boolean;
  reason?: string;
}

/**
 * Settle a paid pass: open the band for the PAIR.
 *
 * The order is the one Rematch established and is what makes the invariant
 * above true rather than hopeful:
 *
 *   1. Durable row FIRST, keyed by the unique charge id. `P2002` means Telegram
 *      redelivered `successful_payment` → idempotent no-op. Writing before the
 *      claim means a crash mid-settle still leaves proof money was taken, which
 *      the sweep refunds.
 *   2. Claim the unlock with a CAS on `primeTimeUnlockedAt IS NULL`.
 *   3. Commit the outcome: `settled`, or a refund because the claim bought
 *      nothing (both sides had an invoice open and the other one landed first).
 */
export async function settlePrimeTimePayment(
  api: Api<RawApi>,
  payerTelegramId: bigint,
  matchId: string,
  telegramChargeId: string,
): Promise<PrimeTimeSettleResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      primeTimeUnlockedAt: true,
      userA: { select: { id: true, telegramId: true, firstName: true, language: true } },
      userB: { select: { id: true, telegramId: true, firstName: true, language: true } },
    },
  });
  if (!match) return { ok: false, reason: "match-not-found" };

  const isA = match.userA.telegramId === payerTelegramId;
  const isB = match.userB.telegramId === payerTelegramId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };
  const payer = isA ? match.userA : match.userB;
  const peer = isA ? match.userB : match.userA;

  let purchase: PrimeTimePurchaseRecord;
  try {
    purchase = await prisma.primeTimePurchase.create({
      data: {
        userId: payer.id,
        matchId,
        status: PRIME_PURCHASE_PROCESSING,
        externalPaymentId: telegramChargeId,
        amountStars: env.PRIME_TIME_STARS,
      },
      select: PRIME_PURCHASE_SELECT,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.info(
        `[prime-time] duplicate successful_payment ignored match=${matchId} ` +
          `charge=${telegramChargeId}`,
      );
      return { ok: true };
    }
    throw err;
  }

  void notifyFounderPurchase({
    userId: payer.id,
    kind: "prime_time",
    provider: "telegram_stars",
    amountStars: env.PRIME_TIME_STARS,
    detail: "поздние вечерние слоты календаря",
    matchId,
    externalPaymentId: telegramChargeId,
  });

  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating", primeTimeUnlockedAt: null },
    data: { primeTimeUnlockedAt: new Date(), primeTimePaidById: payer.id },
  });

  if (claim.count === 0) {
    // The insert proved this is a NEW charge, so an unclaimable band means
    // these Stars bought nothing. Always give them back.
    console.warn(
      `[prime-time] settle claimed nothing match=${matchId} — refunding ${telegramChargeId}`,
    );
    await refundPrimeTimePurchase(
      api,
      purchase,
      payerTelegramId,
      PRIME_PURCHASE_REFUNDED_RACE,
    );
    return { ok: false, reason: "already-unlocked" };
  }

  await prisma.primeTimePurchase
    .update({
      where: { id: purchase.id },
      data: { status: PRIME_PURCHASE_SETTLED, resolvedAt: new Date() },
    })
    .catch(() => {});

  // The partner's grid changes under them within one poll, so tell them why.
  // Quiet and one line — the buyer's own confirmation is the Mini App redrawing
  // with the band open, which is a better receipt than a message.
  if (isTelegramTarget(peer.telegramId)) {
    const lang = (peer.language ?? "en") as Language;
    await api
      .sendMessage(
        Number(peer.telegramId),
        t(lang, "primeTimeOpenedDm", { name: payer.firstName ?? "" }),
      )
      .catch(() => {});
  }

  return { ok: true };
}

/**
 * §9.1 — the date never happened, so the pass comes back.
 *
 * Called from the same six paths that already return a Date Ticket
 * (`services/ticket-refund.ts`). Deliberately keyed on the purchase row rather
 * than on `primeTimeUnlockedAt`: a band opened by a SUBSCRIPTION cost nothing
 * and has nothing to return, and the row is the only thing that knows the
 * difference.
 */
export async function refundPrimeTimeForDeadMatch(
  matchId: string,
  apiOverride?: Api<RawApi> | null,
): Promise<number> {
  // Deliberately NOT gated on `primeTimeFeatureLive()`: money outlives flags,
  // and a pass already paid for must come back even if the feature was switched
  // off in between. The query costs nothing when no row exists, which is every
  // dead match today.
  const api = apiOverride ?? getMainBotApi();
  // Two of the call sites (the stall sweep, the shared cancellation rail) have
  // no handler context, so the process-wide handle is the same idiom
  // `emergency-cancel.ts` already uses. Before the bot has booted there is
  // nobody to refund through — leave the row for the hourly sweep.
  if (!api) return 0;
  const rows = await prisma.primeTimePurchase.findMany({
    where: { matchId, status: PRIME_PURCHASE_SETTLED },
    select: {
      ...PRIME_PURCHASE_SELECT,
      user: { select: { telegramId: true, language: true } },
    },
  });

  let refunded = 0;
  for (const row of rows) {
    if (!isTelegramTarget(row.user.telegramId)) continue;
    const ok = await refundPrimeTimePurchase(
      api,
      {
        id: row.id,
        userId: row.userId,
        status: row.status,
        amountStars: row.amountStars,
        externalPaymentId: row.externalPaymentId,
      },
      row.user.telegramId,
      PRIME_PURCHASE_REFUNDED_MATCH_DIED,
    );
    if (!ok) continue;
    refunded++;
    const lang = (row.user.language ?? "en") as Language;
    await api
      .sendMessage(Number(row.user.telegramId), t(lang, "primeTimeRefundedDateOff"))
      .catch(() => {});
  }
  return refunded;
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

export interface PrimeTimeRefundSweepResult {
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
 * Hourly sweep: retry `refund_failed` and refund abandoned `processing` rows.
 * Registered only when the feature is live, mirroring the venue-change sweep.
 */
export async function sweepPrimeTimeRefunds(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<PrimeTimeRefundSweepResult> {
  const staleBefore = new Date(now.getTime() - PRIME_PROCESSING_STALE_MS);
  // Fresh money first: a `processing` row is a charge that has been taken and
  // never resolved, so it is the one the user is actually owed right now.
  const [stale, retries] = await Promise.all([
    prisma.primeTimePurchase.findMany({
      where: { status: PRIME_PURCHASE_PROCESSING, createdAt: { lt: staleBefore } },
      select: {
      ...PRIME_PURCHASE_SELECT,
      user: { select: { telegramId: true, language: true } },
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_STALE_BUDGET,
    }),
    prisma.primeTimePurchase.findMany({
      where: { status: PRIME_PURCHASE_REFUND_FAILED },
      select: {
      ...PRIME_PURCHASE_SELECT,
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

  const result: PrimeTimeRefundSweepResult = {
    scanned: rows.length,
    refunded: 0,
    stillFailing: 0,
    skipped: 0,
  };

  for (const row of rows) {
    // A mobile-only user carries a synthetic negative id and cannot hold a
    // Stars charge, so there is nothing to reverse through this rail.
    if (!isTelegramTarget(row.user.telegramId)) {
      result.skipped++;
      continue;
    }
    const target =
      row.status === PRIME_PURCHASE_PROCESSING
        ? PRIME_PURCHASE_REFUNDED_STALE
        : PRIME_PURCHASE_REFUNDED_RACE;
    const ok = await refundPrimeTimePurchase(
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
      .sendMessage(Number(row.user.telegramId), t(lang, "primeTimeRefunded"))
      .catch(() => {});
  }

  if (result.scanned > 0) {
    console.log(
      `[prime-time-refund] scanned=${result.scanned} refunded=${result.refunded} ` +
        `stillFailing=${result.stillFailing} skipped=${result.skipped}`,
    );
  }
  return result;
}
