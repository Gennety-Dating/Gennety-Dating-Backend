import { beforeEach, describe, expect, it, vi } from "vitest";

const ledgerFindUnique = vi.fn();
const ledgerCreate = vi.fn();
const userUpdate = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    ticketLedger: { findUnique: ledgerFindUnique, create: ledgerCreate },
    user: { update: userUpdate },
    $transaction: vi.fn(async (ops: unknown[]) => {
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }),
  },
}));

const envMock = { APPSTORE_BUNDLE_ID: "com.gennety.ios" };
vi.mock("../config.js", () => ({ env: envMock }));

const getVerifiedTransaction = vi.fn();
const ticketCountForProduct = vi.fn();
vi.mock("./appstore.js", () => ({
  getVerifiedTransaction,
  ticketCountForProduct,
}));

const grantTickets = vi.fn();
const getBalance = vi.fn();
vi.mock("./ticket-wallet.js", () => ({
  grantTickets,
  getBalance,
  isUniqueViolation: (err: unknown) =>
    typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002",
}));

const { creditAppStoreTransaction, refundAppStoreTransaction } = await import(
  "./appstore-tickets.js"
);

const okTx = {
  transactionId: "tx-1",
  originalTransactionId: null,
  bundleId: "com.gennety.ios",
  productId: "com.gennety.ios.ticket_3",
  quantity: 1,
  revocationDate: null,
};

beforeEach(() => {
  ledgerFindUnique.mockReset();
  ledgerCreate.mockReset().mockResolvedValue({});
  userUpdate.mockReset().mockResolvedValue({ ticketBalance: 0 });
  getVerifiedTransaction.mockReset();
  ticketCountForProduct.mockReset().mockReturnValue(3);
  grantTickets.mockReset().mockResolvedValue(5);
  getBalance.mockReset().mockResolvedValue(5);
});

describe("creditAppStoreTransaction", () => {
  it("credits exactly-once with the appstore external id", async () => {
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction: okTx });
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "credited",
      balance: 5,
      credited: 3,
    });
    expect(grantTickets).toHaveBeenCalledWith({
      userId: "u1",
      count: 3,
      reason: "store_purchase",
      bundleSize: 3,
      externalPaymentId: "appstore:tx-1",
    });
  });

  it("treats a duplicate submission as already_processed", async () => {
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction: okTx });
    grantTickets.mockRejectedValue({ code: "P2002" });
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "already_processed",
      balance: 5,
    });
  });

  it("rejects wrong bundle, revoked, and unknown products", async () => {
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, bundleId: "com.evil.app" },
    });
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "invalid",
      reason: "wrong_bundle",
    });

    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, revocationDate: 123 },
    });
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "invalid",
      reason: "revoked",
    });

    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction: okTx });
    ticketCountForProduct.mockReturnValue(null);
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "invalid",
      reason: "unknown_product",
    });
  });

  it("propagates not_found and unavailable lookups", async () => {
    getVerifiedTransaction.mockResolvedValue({ status: "not_found" });
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "invalid",
      reason: "unknown_transaction",
    });
    getVerifiedTransaction.mockResolvedValue({ status: "unavailable" });
    await expect(creditAppStoreTransaction("u1", "tx-1")).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("refundAppStoreTransaction", () => {
  it("claws back the credited amount with a compensating refund row", async () => {
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: 3 });
    userUpdate.mockResolvedValue({ ticketBalance: -1 });
    await expect(
      refundAppStoreTransaction({ ...okTx, revocationDate: 123 }),
    ).resolves.toEqual({ status: "refunded", balance: -1 });
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        delta: -3,
        reason: "refund",
        externalPaymentId: "appstore:tx-1:refund",
      },
    });
  });

  it("is exactly-once and ignores unknown credits / non-revoked transactions", async () => {
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: 3 });
    ledgerCreate.mockRejectedValue({ code: "P2002" });
    await expect(
      refundAppStoreTransaction({ ...okTx, revocationDate: 123 }),
    ).resolves.toEqual({ status: "already_refunded" });

    ledgerFindUnique.mockResolvedValue(null);
    ledgerCreate.mockResolvedValue({});
    await expect(
      refundAppStoreTransaction({ ...okTx, revocationDate: 123 }),
    ).resolves.toEqual({ status: "no_credit" });

    await expect(refundAppStoreTransaction(okTx)).resolves.toEqual({
      status: "not_revoked",
    });
  });
});
