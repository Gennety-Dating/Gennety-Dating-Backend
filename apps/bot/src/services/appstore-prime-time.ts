import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { getVerifiedTransaction, type AppStoreTransaction } from "./appstore.js";
import {
  notifyFounderAppStoreUnclaimed,
  notifyFounderPurchase,
  notifyFounderPurchaseRefunded,
} from "./founder-notify.js";
import { isPrimeTimeProduct, primeTimeUnlockReason } from "./prime-time.js";
import {
  appStoreManualRefundNote,
  appStoreManualRefundReason,
  PRIME_PROCESSING_STALE_MS,
  PRIME_PURCHASE_PROCESSING,
  PRIME_PURCHASE_REFUND_MANUAL,
  PRIME_PURCHASE_REFUNDED_APPSTORE,
  PRIME_PURCHASE_SETTLED,
} from "./prime-time-purchase.js";
import { telegramReachable } from "./telegram-reach.js";
import { APPSTORE_PAYMENT_PREFIX } from "./venue-change-refund.js";

/**
 * StoreKit 2 → the Prime Time pass (M7, 2026-09-14).
 *
 * The native app's till for the same pass the Mini App sells in Stars: Apple
 * does not allow a second payment rail for a digital good inside the app
 * (guideline 3.1.1). The shape is `appstore-venue-change.ts`'s — the client's
 * JWS is decoded route-side only to lift a transaction id, and every fact used
 * to decide anything comes back from Apple — and what happens after the money
 * is the Stars rail's CAS on `primeTimeUnlockedAt`.
 *
 * What differs from Stars is the one thing this till cannot do: give money
 * back. A pass that could not be applied (the partner opened the band in the
 * same moment, the pair locked a date, the buyer is not in the match) is parked
 * as `refund_manual` with a founder alert and answered 409 — never presented as
 * a refund that has happened.
 *
 * ── Exactly-once, and the same answer every time ───────────────────────
 *
 * `externalPaymentId = appstore:<transactionId>` is unique. The client re-sends
 * every transaction it has not finished, and it only finishes on a final
 * answer, so a re-report must get the SAME answer the first report got:
 * `settled` → 200, `refund_manual` → the same 409 code. A `processing` row is a
 * report still in flight (503, retry) — unless it is older than the Stars
 * sweep's stale window, which means the first report died between its row and
 * its claim; then this report finishes the settle itself. Nothing else ever
 * moves an App Store row out of `processing` (the Stars sweep excludes the
 * prefix), so without that resume a crash would 503 the purchase forever.
 *
 * ── Demo mode ──────────────────────────────────────────────────────────
 *
 * No branch, same as the venue-change till: the demo bot is a Telegram
 * surface and never reaches a JWT route. A native build pointed at a demo
 * server still goes through Apple's verification — there is no free settle
 * here to imitate.
 */

export type PrimeTimeInvalidReason =
  | "unknown_transaction"
  | "wrong_bundle"
  | "unknown_product"
  | "revoked"
  | "wrong_owner";

/** Charged, not applied — parked for a manual refund. */
export type PrimeTimeUnclaimedReason = "already_unlocked" | "match_closed" | "not_participant";

const UNCLAIMED_REASONS: ReadonlySet<string> = new Set<PrimeTimeUnclaimedReason>([
  "already_unlocked",
  "match_closed",
  "not_participant",
]);

export type PrimeTimePassPurchaseResult =
  | { status: "settled" }
  | { status: "invalid"; reason: PrimeTimeInvalidReason }
  | { status: "unclaimed"; reason: PrimeTimeUnclaimedReason }
  | { status: "unavailable" };

const PARTICIPANT_SELECT = {
  id: true,
  telegramId: true,
  platform: true,
  premiumUntil: true,
  firstName: true,
  language: true,
} satisfies Prisma.UserSelect;

const MATCH_SELECT = {
  id: true,
  status: true,
  userAId: true,
  userBId: true,
  primeTimeUnlockedAt: true,
  availableTimesA: true,
  availableTimesB: true,
  userA: { select: PARTICIPANT_SELECT },
  userB: { select: PARTICIPANT_SELECT },
} satisfies Prisma.MatchSelect;

type SettleMatch = Prisma.MatchGetPayload<{ select: typeof MATCH_SELECT }>;

/** Rolls the claim back: the purchase row left `processing` under us. */
class PurchaseLeftProcessing extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

export async function purchasePrimeTimePass(
  api: Api<RawApi>,
  userId: string,
  matchId: string,
  transactionId: string,
  now: Date = new Date(),
): Promise<PrimeTimePassPurchaseResult> {
  const lookup = await getVerifiedTransaction(transactionId);
  if (lookup.status === "unavailable") return { status: "unavailable" };
  if (lookup.status === "not_found") {
    return { status: "invalid", reason: "unknown_transaction" };
  }

  const tx = lookup.transaction;
  if (tx.bundleId !== env.APPSTORE_BUNDLE_ID) {
    return { status: "invalid", reason: "wrong_bundle" };
  }
  if (tx.revocationDate !== null) {
    return { status: "invalid", reason: "revoked" };
  }
  // Verified when present rather than required, as on every other till: the
  // native client does not set `appAccountToken` today, and a purchase without
  // it must not be refused.
  if (tx.appAccountToken !== null && tx.appAccountToken.toLowerCase() !== userId.toLowerCase()) {
    console.error(
      `[prime-time] transaction ${tx.transactionId} was bought by ` +
        `${tx.appAccountToken} but claimed by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  if (!isPrimeTimeProduct(tx.productId)) {
    return { status: "invalid", reason: "unknown_product" };
  }

  const externalPaymentId = `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`;

  // (1) The durable row first, exactly as on the Stars rail: a crash after this
  // point still leaves proof that money was taken.
  let purchaseId: string;
  try {
    const row = await prisma.primeTimePurchase.create({
      data: {
        userId,
        matchId,
        status: PRIME_PURCHASE_PROCESSING,
        externalPaymentId,
        // Not a Stars purchase — zero is the honest reading of "this rail
        // charged no Stars". What Apple charged rides the founder notice as
        // cents; a money column of its own would be a schema change, which is
        // the founder's call (the venue change made the same one).
        amountStars: 0,
      },
      select: { id: true },
    });
    purchaseId = row.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return answerReport(api, userId, externalPaymentId, tx, now, true);
  }

  return settle(api, purchaseId, userId, matchId, tx, now);
}

/**
 * A report of a transaction that already has a row: answer as the first
 * report was answered. `allowResume` is false when called from inside a settle
 * that lost its own CAS, so a stale row is never resumed twice in one request.
 */
async function answerReport(
  api: Api<RawApi>,
  userId: string,
  externalPaymentId: string,
  tx: AppStoreTransaction,
  now: Date,
  allowResume: boolean,
): Promise<PrimeTimePassPurchaseResult> {
  const existing = await prisma.primeTimePurchase.findUnique({
    where: { externalPaymentId },
    select: {
      id: true,
      userId: true,
      matchId: true,
      status: true,
      refundError: true,
      createdAt: true,
    },
  });
  if (!existing) return { status: "unavailable" };

  // One transaction, one owner: the first account to report it. A second
  // account re-sending the same JWS gets nothing from it.
  if (existing.userId !== userId) {
    console.error(
      `[prime-time] ${externalPaymentId} belongs to ${existing.userId ?? "a deleted account"} ` +
        `but was re-reported by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }

  switch (existing.status) {
    case PRIME_PURCHASE_SETTLED:
    case PRIME_PURCHASE_REFUNDED_APPSTORE:
      return { status: "settled" };
    case PRIME_PURCHASE_REFUND_MANUAL: {
      const reason = appStoreManualRefundReason(existing.refundError);
      // Parked AFTER it settled, because the date later died (§9.1): the pass
      // did open the band, so the purchase itself was answered 200.
      if (reason === "match_died") return { status: "settled" };
      return {
        status: "unclaimed",
        reason: reason !== null && UNCLAIMED_REASONS.has(reason)
          ? (reason as PrimeTimeUnclaimedReason)
          : "already_unlocked",
      };
    }
    case PRIME_PURCHASE_PROCESSING: {
      const age = now.getTime() - existing.createdAt.getTime();
      if (!allowResume || age < PRIME_PROCESSING_STALE_MS) return { status: "unavailable" };
      console.warn(
        `[prime-time] resuming an abandoned App Store settle purchase=${existing.id} ` +
          `charge=${externalPaymentId}`,
      );
      return settle(api, existing.id, userId, existing.matchId, tx, now);
    }
    default:
      console.error(
        `[prime-time] App Store purchase ${existing.id} in unexpected status ${existing.status}`,
      );
      return { status: "unavailable" };
  }
}

/** Decide, claim and record — the row is ours and still `processing`. */
async function settle(
  api: Api<RawApi>,
  purchaseId: string,
  userId: string,
  matchId: string,
  tx: AppStoreTransaction,
  now: Date,
): Promise<PrimeTimePassPurchaseResult> {
  const externalPaymentId = `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`;
  let match: SettleMatch | null = null;
  let outcome: "settled" | PrimeTimeUnclaimedReason | "taken";
  try {
    outcome = await prisma.$transaction(
      async (db): Promise<"settled" | PrimeTimeUnclaimedReason> => {
        match = await db.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
        if (!match || (match.userAId !== userId && match.userBId !== userId)) {
          return "not_participant";
        }
        // Status before the band: a pair that has already locked a date is
        // not a pair whose evening can be bought, whatever the band says.
        if (match.status !== "negotiating") return "match_closed";
        // Premium on either side, the partner's pass, a grandfathered mark —
        // every reason the band is open already means this pass bought nothing.
        if (primeTimeUnlockReason(match, now) !== null) return "already_unlocked";

        const claim = await db.match.updateMany({
          where: { id: matchId, status: "negotiating", primeTimeUnlockedAt: null },
          data: { primeTimeUnlockedAt: new Date(), primeTimePaidById: userId },
        });
        if (claim.count === 0) return "already_unlocked";

        const settled = await db.primeTimePurchase.updateMany({
          where: { id: purchaseId, status: PRIME_PURCHASE_PROCESSING },
          data: { status: PRIME_PURCHASE_SETTLED, resolvedAt: new Date() },
        });
        if (settled.count === 0) throw new PurchaseLeftProcessing();
        return "settled";
      },
    );
  } catch (err) {
    if (!(err instanceof PurchaseLeftProcessing)) throw err;
    outcome = "taken";
  }

  // Someone else resolved this row first (a concurrent resume of the same
  // report). Their answer is the answer.
  if (outcome === "taken") {
    return answerReport(api, userId, externalPaymentId, tx, now, false);
  }

  const sandbox = tx.environment === "Sandbox";

  if (outcome !== "settled") {
    const parked = await prisma.primeTimePurchase.updateMany({
      where: { id: purchaseId, status: PRIME_PURCHASE_PROCESSING },
      data: {
        status: PRIME_PURCHASE_REFUND_MANUAL,
        resolvedAt: new Date(),
        refundError: appStoreManualRefundNote(outcome, externalPaymentId),
      },
    });
    if (parked.count === 0) {
      return answerReport(api, userId, externalPaymentId, tx, now, false);
    }
    console.error(
      `[prime-time] App Store pass bought nothing match=${matchId} ` +
        `charge=${externalPaymentId} reason=${outcome} — needs a manual refund`,
    );
    await notifyFounderAppStoreUnclaimed({
      userId,
      kind: "prime_time",
      externalPaymentId,
      reason: outcome,
      matchId,
      amountCents: tx.priceCents,
      currency: tx.currency,
      sandbox,
    });
    return { status: "unclaimed", reason: outcome };
  }

  console.info(
    `[prime-time] settled via App Store match=${matchId} payer=${userId} charge=${externalPaymentId}`,
  );
  void notifyFounderPurchase({
    userId,
    kind: "prime_time",
    provider: "app_store",
    amountCents: tx.priceCents,
    currency: tx.currency,
    detail: "поздние вечерние слоты календаря",
    matchId,
    externalPaymentId,
    sandbox,
  });

  // The partner's grid changes under them within one poll, so tell a Telegram
  // partner why — the same line the Stars rail sends. An app partner simply
  // sees the band open on the next poll (a push is out of scope for M7).
  const settledMatch = match as SettleMatch | null;
  if (settledMatch) {
    const payerIsA = settledMatch.userAId === userId;
    const payer = payerIsA ? settledMatch.userA : settledMatch.userB;
    const peer = payerIsA ? settledMatch.userB : settledMatch.userA;
    if (telegramReachable(peer)) {
      const lang = (peer.language ?? "en") as Language;
      await api
        .sendMessage(
          Number(peer.telegramId),
          t(lang, "primeTimeOpenedDm", { name: payer.firstName ?? "" }),
        )
        .catch(() => {});
    }
  }
  return { status: "settled" };
}

export type PrimeTimeAppStoreRefundResult =
  | { status: "not_revoked" }
  | { status: "no_purchase" }
  | { status: "already_recorded" }
  | { status: "recorded" };

/**
 * Apple refunded or revoked a pass (App Store Server Notification) — R6.
 *
 * Recorded and announced; the band is NOT locked again. The partner may
 * already have marked an evening on it, and taking back a slot a pair chose is
 * the move this feature never makes (§13.2 — it is why a lapsed subscription
 * does not re-lock either). The loss is the price of that rule and belongs in
 * front of a person, which is what the founder notice is.
 *
 * `tx` is Apple's authoritative transaction, re-fetched by the webhook.
 */
export async function refundPrimeTimeAppStoreTransaction(
  tx: AppStoreTransaction,
): Promise<PrimeTimeAppStoreRefundResult> {
  if (tx.revocationDate === null) return { status: "not_revoked" };
  const externalPaymentId = `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`;

  const row = await prisma.primeTimePurchase.findUnique({
    where: { externalPaymentId },
    select: { id: true, userId: true, status: true },
  });
  if (!row) return { status: "no_purchase" };
  if (row.status === PRIME_PURCHASE_REFUNDED_APPSTORE) return { status: "already_recorded" };

  // Conditional on the status just read, so Apple's retries (and a report
  // racing this) record — and announce — the refund once.
  const moved = await prisma.primeTimePurchase.updateMany({
    where: { id: row.id, status: row.status },
    data: { status: PRIME_PURCHASE_REFUNDED_APPSTORE, resolvedAt: new Date() },
  });
  if (moved.count === 0) return { status: "already_recorded" };

  void notifyFounderPurchaseRefunded({
    userId: row.userId,
    kind: "prime_time",
    amountCents: tx.priceCents,
    currency: tx.currency,
    reason:
      row.status === PRIME_PURCHASE_REFUND_MANUAL
        ? "Apple вернул покупку (refund/revoke) — ручной возврат больше не нужен"
        : "Apple вернул покупку (refund/revoke); вечерняя полоса остаётся открытой",
    externalPaymentId,
  });
  return { status: "recorded" };
}
