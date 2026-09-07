import { prisma } from "@gennety/db";
import {
  getVerifiedTransaction,
  ticketCountForProduct,
  type AppStoreTransaction,
} from "./appstore.js";
import { env } from "../config.js";
import {
  clawbackTickets,
  getBalance,
  grantTickets,
  isUniqueViolation,
} from "./ticket-wallet.js";
import {
  notifyFounderPurchase,
  notifyFounderPurchaseRefunded,
  notifyFounderSubsystemHealth,
} from "./founder-notify.js";

/**
 * StoreKit 2 ticket credits + refund claw-backs (IOS_APP_ROADMAP task 0.10).
 *
 * Credits ride the same exactly-once machinery as Telegram Stars: the unique
 * `TicketLedger.externalPaymentId` (`appstore:<transactionId>`) makes a
 * re-submitted transaction an idempotent no-op. Refunds append a
 * compensating `refund` row keyed `appstore:<transactionId>:refund` — also
 * exactly-once — and MAY drive the balance negative (honest accounting when
 * the user already spent the refunded tickets).
 */

export type AppStoreCreditResult =
  | { status: "credited"; balance: number; credited: number }
  | { status: "already_processed"; balance: number }
  | { status: "invalid"; reason:
        | "bad_jws"
        | "unknown_transaction"
        | "wrong_bundle"
        | "unknown_product"
        | "revoked"
        | "wrong_owner";
    }
  | { status: "unavailable" };

/**
 * Verify a client-submitted transactionId against Apple and credit the
 * wallet. The client's JWS is decoded route-side ONLY to extract the id —
 * every fact used here comes from Apple's answer.
 */
export async function creditAppStoreTransaction(
  userId: string,
  transactionId: string,
): Promise<AppStoreCreditResult> {
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
  // Whose purchase is this?
  //
  // Nothing used to ask. `externalPaymentId` is unique, so ownership was
  // settled by a race: whoever submitted a given `transactionId` first got the
  // tickets. `appAccountToken` is the client-set UUID Apple echoes back, and it
  // is the only field in the payload that says who was buying.
  //
  // Verified when present rather than required, because builds already in the
  // wild do not set it and refusing them would break real purchases. A mismatch
  // is refused outright; an absent token is recorded so the day it is always
  // present is visible in the logs rather than guessed at.
  // Both sides folded here rather than trusting the decoder alone: this type is
  // also built by the webhook path, and a UUID's case carries no meaning.
  if (
    tx.appAccountToken !== null &&
    tx.appAccountToken.toLowerCase() !== userId.toLowerCase()
  ) {
    console.error(
      `[appstore] transaction ${tx.transactionId} was bought by ` +
        `${tx.appAccountToken} but claimed by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  if (tx.appAccountToken === null) {
    console.info(
      `[appstore] transaction ${tx.transactionId} carries no appAccountToken — ` +
        "ownership unverified (pre-token client build)",
    );
  }
  const perPurchase = ticketCountForProduct(tx.productId);
  if (!perPurchase) return { status: "invalid", reason: "unknown_product" };

  const credited = perPurchase * tx.quantity;
  try {
    const balance = await grantTickets({
      userId,
      count: credited,
      reason: "store_purchase",
      bundleSize: perPurchase,
      ...(tx.priceCents != null ? { amountCents: tx.priceCents } : {}),
      externalPaymentId: `appstore:${tx.transactionId}`,
    });
    // Founder ops feed — the iOS twin of the Telegram Stars store purchase.
    // After the exactly-once credit, so a re-submitted transaction (the
    // `already_processed` branch below) never re-announces the sale.
    void notifyFounderPurchase({
      userId,
      kind: "tickets",
      provider: "app_store",
      amountCents: tx.priceCents,
      currency: tx.currency,
      detail: `${credited} ticket${credited === 1 ? "" : "s"} · ${tx.productId ?? "?"} · баланс ${balance}`,
      externalPaymentId: `appstore:${tx.transactionId}`,
    });
    return { status: "credited", balance, credited };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: "already_processed", balance: await getBalance(userId) };
    }
    throw err;
  }
}

export type AppStoreRefundResult =
  | { status: "refunded"; balance: number }
  | { status: "no_credit" }
  | { status: "already_refunded" }
  | { status: "not_revoked" };

/**
 * Claw back a store credit after Apple reports the purchase refunded/revoked
 * (Server Notification V2 → authoritative re-fetch). Finds our original
 * credit row by its external id, then appends the compensating refund row
 * and decrements the balance in one transaction.
 */
export async function refundAppStoreTransaction(
  tx: AppStoreTransaction,
): Promise<AppStoreRefundResult> {
  if (tx.revocationDate === null) return { status: "not_revoked" };

  const credit = await prisma.ticketLedger.findUnique({
    where: { externalPaymentId: `appstore:${tx.transactionId}` },
    select: { userId: true, delta: true },
  });
  if (!credit) return { status: "no_credit" };

  try {
    // Through the wallet's guarded writer, not around it. This used to be an
    // unconditional `user.update({ decrement })` — the one write in the product
    // that bypassed the CAS whose docstring says the balance can never go
    // negative — so "buy six, spend six, refund at Apple" left the wallet at
    // −6, and the next free bonus quietly paid that debt off.
    const clawback = await clawbackTickets({
      userId: credit.userId,
      count: credit.delta,
      externalPaymentId: `appstore:${tx.transactionId}:refund`,
    });

    void notifyFounderPurchaseRefunded({
      userId: credit.userId,
      kind: "tickets",
      reason: "Apple refunded/revoked the purchase",
      externalPaymentId: `appstore:${tx.transactionId}`,
    });

    if (clawback.shortfall > 0) {
      // Spent before the refund arrived, so there is nothing left to take back.
      // The tickets bought real dates; the loss is real and belongs in front of
      // a person rather than inside a balance nobody reads.
      console.error(
        `[appstore] refund exceeded the wallet: user=${credit.userId} ` +
          `refunded=${credit.delta} reclaimed=${clawback.taken} ` +
          `shortfall=${clawback.shortfall} charge=appstore:${tx.transactionId}`,
      );
      void notifyFounderSubsystemHealth(
        `возврат App Store: ${clawback.shortfall} билет(ов) уже потрачено`,
        "degraded",
        clawback.shortfall,
      );
    }

    return { status: "refunded", balance: clawback.balance };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "already_refunded" };
    throw err;
  }
}
