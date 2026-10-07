import { env } from "../config.js";
import { getVerifiedTransaction, type AppStoreTransaction } from "./appstore.js";
import {
  notifyFounderAppStoreUnclaimed,
  notifyFounderPurchase,
} from "./founder-notify.js";
import { APPSTORE_PAYMENT_PREFIX } from "./venue-change-refund.js";
import {
  markWishlistUnlockRefunded,
  recordWishlistUnlock,
  wishlistPurchasable,
} from "./wishlist.js";

/**
 * The app's till for the Date Wishlist cheat sheet (decision journal
 * 2026-10-08): a StoreKit CONSUMABLE (`WISHLIST_APPSTORE_PRODUCT_ID`, the
 * $2.99 tier) reported to `POST /v1/me/after-date/:matchId/wishlist/appstore`.
 *
 * Simpler than the Prime Time till on purpose: opening a sheet is a grant to
 * ONE viewer with no pair-level race and no state to roll back, so there is
 * no `processing` row and no sweep — the transaction is verified with Apple,
 * then the unlock row is written idempotently on `appstore:<transactionId>`.
 * A purchase that can no longer be honoured (the pair stopped being mutual,
 * the owner withdrew the list, it was already open) is answered `unclaimed`
 * and reported to the founder with the transaction id: Apple refunds a
 * consumable, not us.
 */

export type WishlistAppStoreResult =
  | { status: "unlocked" }
  | { status: "invalid"; reason: "unknown_transaction" | "wrong_bundle" | "unknown_product" | "revoked" | "wrong_owner" }
  | { status: "unclaimed"; reason: string }
  | { status: "unavailable" };

export function isWishlistProduct(productId: string | null): boolean {
  if (!productId) return false;
  const target = env.WISHLIST_APPSTORE_PRODUCT_ID;
  return productId === target || productId.split(".").pop() === target;
}

export async function purchaseWishlistSheet(
  userId: string,
  matchId: string,
  transactionId: string,
): Promise<WishlistAppStoreResult> {
  const lookup = await getVerifiedTransaction(transactionId);
  if (lookup.status === "unavailable") return { status: "unavailable" };
  if (lookup.status === "not_found") return { status: "invalid", reason: "unknown_transaction" };

  const tx = lookup.transaction;
  if (tx.bundleId !== env.APPSTORE_BUNDLE_ID) return { status: "invalid", reason: "wrong_bundle" };
  if (tx.revocationDate !== null) return { status: "invalid", reason: "revoked" };
  if (tx.appAccountToken !== null && tx.appAccountToken.toLowerCase() !== userId.toLowerCase()) {
    console.error(
      `[wishlist] transaction ${tx.transactionId} was bought by ${tx.appAccountToken} but claimed by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  if (!isWishlistProduct(tx.productId)) return { status: "invalid", reason: "unknown_product" };

  const externalPaymentId = `${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`;
  const amountCents = tx.priceCents;

  const purchasable = await wishlistPurchasable(matchId, userId);
  if (!purchasable.ok) {
    // A re-report of a transaction we already honoured is not "unclaimed".
    if (purchasable.error === "already-unlocked") {
      const outcome = await alreadyRecorded(externalPaymentId);
      if (outcome) return { status: "unlocked" };
    }
    void notifyFounderAppStoreUnclaimed({
      userId,
      kind: "wishlist",
      externalPaymentId,
      reason: purchasable.error,
      matchId,
      amountCents,
      currency: tx.currency ?? null,
      sandbox: tx.environment === "Sandbox",
    }).catch(() => undefined);
    return { status: "unclaimed", reason: purchasable.error };
  }

  const recorded = await recordWishlistUnlock({
    matchId,
    viewerId: userId,
    ownerId: purchasable.ownerId,
    provider: "app_store",
    externalPaymentId,
    amountCents,
  });
  if (recorded === "created") {
    void notifyFounderPurchase({
      userId,
      kind: "wishlist",
      provider: "app_store",
      amountCents,
      currency: tx.currency ?? null,
      detail: "Date Wishlist",
      matchId,
      externalPaymentId,
      sandbox: tx.environment === "Sandbox",
    }).catch(() => undefined);
  }
  return { status: "unlocked" };
}

async function alreadyRecorded(externalPaymentId: string): Promise<boolean> {
  const { prisma } = await import("@gennety/db");
  const row = await prisma.wishlistUnlock.findUnique({
    where: { externalPaymentId },
    select: { id: true },
  });
  return row != null;
}

/** REFUND / REVOKE from Apple: the sheet closes for that viewer. */
export async function refundWishlistAppStoreTransaction(
  tx: AppStoreTransaction,
): Promise<{ status: "refunded" | "unknown" }> {
  const done = await markWishlistUnlockRefunded(`${APPSTORE_PAYMENT_PREFIX}${tx.transactionId}`);
  return { status: done ? "refunded" : "unknown" };
}
