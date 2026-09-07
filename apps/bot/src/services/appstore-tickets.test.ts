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
const clawbackTickets = vi.fn();
vi.mock("./ticket-wallet.js", () => ({
  grantTickets,
  getBalance,
  clawbackTickets,
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
  expiresDate: null,
  priceCents: 1647,
  currency: "USD",
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
      // Apple reports the charged price; it is frozen on the row so the admin
      // purchase list shows a real number rather than a Stars estimate.
      amountCents: 1647,
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
  it("claws back through the wallet's guarded writer, not around it", async () => {
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: 3 });
    clawbackTickets.mockResolvedValue({ taken: 3, shortfall: 0, balance: 1 });

    await expect(
      refundAppStoreTransaction({ ...okTx, revocationDate: 123 }),
    ).resolves.toEqual({ status: "refunded", balance: 1 });

    // The unconditional `user.update({ decrement })` this used to do was the
    // one write in the product that bypassed the CAS whose docstring says the
    // balance can never go negative.
    expect(clawbackTickets).toHaveBeenCalledWith({
      userId: "u1",
      count: 3,
      externalPaymentId: "appstore:tx-1:refund",
    });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("reports a refund that outran the wallet instead of carrying it as debt", async () => {
    // Buy six, spend six, refund at Apple. The balance used to land at −6 — a
    // number that is not a count of anything — and the next free bonus quietly
    // paid that debt off, so the loss never appeared as a loss.
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: 6 });
    clawbackTickets.mockResolvedValue({ taken: 0, shortfall: 6, balance: 0 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await refundAppStoreTransaction({ ...okTx, revocationDate: 123 });

    expect(result).toEqual({ status: "refunded", balance: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("shortfall=6"));
    error.mockRestore();
  });

  it("is exactly-once and ignores unknown credits / non-revoked transactions", async () => {
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: 3 });
    clawbackTickets.mockRejectedValue({ code: "P2002" });
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
