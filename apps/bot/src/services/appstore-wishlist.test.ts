import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreTransaction } from "./appstore.js";

const envMock = { APPSTORE_BUNDLE_ID: "com.gennety.ios", WISHLIST_APPSTORE_PRODUCT_ID: "wishlist_sheet" };
vi.mock("../config.js", () => ({ env: envMock }));

const getVerifiedTransaction = vi.fn();
vi.mock("./appstore.js", async (importOriginal) => ({
  boughtByAnotherUser: (await importOriginal<typeof import("./appstore.js")>()).boughtByAnotherUser,
  getVerifiedTransaction,
}));

const notifyFounderPurchase = vi.fn().mockResolvedValue(undefined);
const notifyFounderAppStoreUnclaimed = vi.fn().mockResolvedValue(undefined);
vi.mock("./founder-notify.js", () => ({ notifyFounderPurchase, notifyFounderAppStoreUnclaimed }));
vi.mock("./venue-change-refund.js", () => ({ APPSTORE_PAYMENT_PREFIX: "appstore:" }));

const wishlistPurchasable = vi.fn();
const recordWishlistUnlock = vi.fn();
const markWishlistUnlockRefunded = vi.fn();
const reopenWishlistUnlock = vi.fn();
vi.mock("./wishlist.js", () => ({
  wishlistPurchasable,
  recordWishlistUnlock,
  markWishlistUnlockRefunded,
  reopenWishlistUnlock,
}));

const { appAccountTokenFor } = await vi.importActual<typeof import("./appstore.js")>("./appstore.js");
const { purchaseWishlistSheet, refundWishlistAppStoreTransaction, reverseWishlistAppStoreRefund } =
  await import("./appstore-wishlist.js");

const okTx: AppStoreTransaction = {
  transactionId: "tx-9",
  originalTransactionId: null,
  bundleId: "com.gennety.ios",
  productId: "com.gennety.ios.wishlist_sheet",
  quantity: 1,
  revocationDate: null,
  expiresDate: null,
  purchaseDate: null,
  environment: "Production",
  priceCents: 299,
  currency: "USD",
  appAccountToken: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  wishlistPurchasable.mockResolvedValue({ ok: true, ownerId: "owner-1" });
  recordWishlistUnlock.mockResolvedValue("created");
});

describe("purchaseWishlistSheet", () => {
  it("honours a purchase tokened the documented way (the derived appAccountToken)", async () => {
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, appAccountToken: appAccountTokenFor("user-1") },
    });

    await expect(purchaseWishlistSheet("user-1", "match-1", "tx-9")).resolves.toEqual({
      status: "unlocked",
    });
    expect(recordWishlistUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ externalPaymentId: "appstore:tx-9", viewerId: "user-1" }),
    );
  });

  it("refuses a transaction another user's token bought", async () => {
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, appAccountToken: appAccountTokenFor("someone-else") },
    });

    await expect(purchaseWishlistSheet("user-1", "match-1", "tx-9")).resolves.toEqual({
      status: "invalid",
      reason: "wrong_owner",
    });
    expect(recordWishlistUnlock).not.toHaveBeenCalled();
  });

  it("answers a second payment for an already-opened sheet as unclaimed, not unlocked", async () => {
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction: okTx });
    recordWishlistUnlock.mockResolvedValue("taken");

    await expect(purchaseWishlistSheet("user-1", "match-1", "tx-9")).resolves.toEqual({
      status: "unclaimed",
      reason: "already-unlocked",
    });
    expect(notifyFounderAppStoreUnclaimed).toHaveBeenCalledTimes(1);
    expect(notifyFounderPurchase).not.toHaveBeenCalled();
  });
});

describe("wishlist refunds", () => {
  it("does not close a sheet while Apple still shows the transaction live", async () => {
    // A CONSUMPTION_REQUEST, or a forged webhook naming a real transaction.
    await expect(refundWishlistAppStoreTransaction(okTx)).resolves.toEqual({
      status: "not_revoked",
    });
    expect(markWishlistUnlockRefunded).not.toHaveBeenCalled();
  });

  it("closes the sheet once Apple has revoked the transaction", async () => {
    markWishlistUnlockRefunded.mockResolvedValue(true);
    await expect(
      refundWishlistAppStoreTransaction({ ...okTx, revocationDate: new Date() }),
    ).resolves.toEqual({ status: "refunded" });
    expect(markWishlistUnlockRefunded).toHaveBeenCalledWith("appstore:tx-9");
  });

  it("reopens the sheet when Apple reverses the refund", async () => {
    reopenWishlistUnlock.mockResolvedValue(true);
    await expect(reverseWishlistAppStoreRefund(okTx)).resolves.toEqual({ status: "reopened" });
    expect(reopenWishlistUnlock).toHaveBeenCalledWith("appstore:tx-9");
  });

  it("leaves the sheet closed while the transaction is still revoked", async () => {
    await expect(
      reverseWishlistAppStoreRefund({ ...okTx, revocationDate: new Date() }),
    ).resolves.toEqual({ status: "still_revoked" });
    expect(reopenWishlistUnlock).not.toHaveBeenCalled();
  });
});
