import type { Api, RawApi } from "grammy";

import { env } from "../config.js";
import { getVerifiedTransaction } from "./appstore.js";
import { settleVenueChangeFromAppStore } from "../handlers/matching/venue-change.js";

/**
 * StoreKit 2 → one settled venue change (2026-09-12).
 *
 * The shape is `appstore-tickets.ts`'s, deliberately: the client's JWS is
 * decoded route-side ONLY to lift a transaction id out of it, and every fact
 * used to decide anything comes back from Apple. What differs is what the
 * purchase buys — tickets credit a wallet, this claims a specific match's
 * pending change — and so what a failure means. A wallet credit can always be
 * applied; a change can be bought a moment too late.
 */

export type VenueChangePurchaseResult =
  | { status: "settled" }
  /** Already applied — the client may `finish()` this transaction. */
  | { status: "already_processed" }
  | {
      status: "invalid";
      reason:
        | "unknown_transaction"
        | "wrong_bundle"
        | "unknown_product"
        | "revoked"
        | "wrong_owner";
    }
  /**
   * Verified and charged, but the change could not be claimed — the partner
   * settled or the session lapsed in the meantime. The purchase is parked for
   * a manual refund and the client is told plainly; it must NOT be presented
   * as a refund that has happened.
   */
  | { status: "unclaimed"; reason: string }
  | { status: "unavailable" };

/** Full product id or its last dot-segment, as every other rail matches. */
function isVenueChangeProduct(productId: string | null): boolean {
  if (!productId) return false;
  const want = env.VENUE_CHANGE_APPSTORE_PRODUCT_ID;
  return productId === want || productId.split(".").pop() === want;
}

export async function purchaseVenueChange(
  api: Api<RawApi>,
  userId: string,
  matchId: string,
  transactionId: string,
): Promise<VenueChangePurchaseResult> {
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
  // Ownership, on the same terms as the ticket rail: `appAccountToken` is the
  // client-set UUID Apple echoes back and the only field that says who was
  // buying. Verified when present rather than required, because a build in the
  // wild that does not set it must not have its purchases refused.
  if (
    tx.appAccountToken !== null &&
    tx.appAccountToken.toLowerCase() !== userId.toLowerCase()
  ) {
    console.error(
      `[venue-change] transaction ${tx.transactionId} was bought by ` +
        `${tx.appAccountToken} but claimed by ${userId}`,
    );
    return { status: "invalid", reason: "wrong_owner" };
  }
  if (!isVenueChangeProduct(tx.productId)) {
    return { status: "invalid", reason: "unknown_product" };
  }

  const settled = await settleVenueChangeFromAppStore(
    api,
    userId,
    matchId,
    tx.transactionId,
    tx.priceCents,
  );
  if (settled.ok) return { status: "settled" };

  // `settleVenueChangeFromAppStore` answers ok for a re-reported purchase, so
  // anything failing here is a genuine refusal. The two that mean "this
  // purchase never became a change" are the ones the client must not retry.
  if (settled.reason === "match-not-found" || settled.reason === "not-participant") {
    return { status: "invalid", reason: "unknown_transaction" };
  }
  return { status: "unclaimed", reason: settled.reason ?? "not-agreed" };
}
