import { prisma } from "@gennety/db";
import {
  getVerifiedTransaction,
  ticketCountForProduct,
  type AppStoreTransaction,
} from "./appstore.js";
import { env } from "../config.js";
import { getBalance, grantTickets, isUniqueViolation } from "./ticket-wallet.js";

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
  | { status: "invalid"; reason: "bad_jws" | "unknown_transaction" | "wrong_bundle" | "unknown_product" | "revoked" }
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
  const perPurchase = ticketCountForProduct(tx.productId);
  if (!perPurchase) return { status: "invalid", reason: "unknown_product" };

  const credited = perPurchase * tx.quantity;
  try {
    const balance = await grantTickets({
      userId,
      count: credited,
      reason: "store_purchase",
      bundleSize: perPurchase,
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
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: credit.userId },
        data: { ticketBalance: { decrement: credit.delta } },
        select: { ticketBalance: true },
      }),
      prisma.ticketLedger.create({
        data: {
          userId: credit.userId,
          delta: -credit.delta,
          reason: "refund",
          externalPaymentId: `appstore:${tx.transactionId}:refund`,
        },
      }),
    ]);
    return { status: "refunded", balance: updated.ticketBalance };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "already_refunded" };
    throw err;
  }
}
