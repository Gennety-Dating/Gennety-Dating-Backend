import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreTransaction } from "./appstore.js";

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
vi.mock("./appstore.js", async (importOriginal) => ({
  boughtByAnotherUser: (await importOriginal<typeof import("./appstore.js")>()).boughtByAnotherUser,
  appAccountTokenFor: (await importOriginal<typeof import("./appstore.js")>()).appAccountTokenFor,
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

const { creditAppStoreTransaction, refundAppStoreTransaction, reverseAppStoreTicketRefund } =
  await import("./appstore-tickets.js");

const okTx: AppStoreTransaction = {
  transactionId: "tx-1",
  originalTransactionId: null,
  bundleId: "com.gennety.ios",
  productId: "com.gennety.ios.ticket_3",
  quantity: 1,
  revocationDate: null,
  expiresDate: null,
  purchaseDate: null,
  environment: "Production",
  priceCents: 1647,
  currency: "USD",
  appAccountToken: null,
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
  it("refuses a transaction someone else bought", async () => {
    // Ownership used to be decided by a race: `externalPaymentId` is unique, so
    // whoever submitted a given `transactionId` first got the tickets.
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, appAccountToken: "11111111-1111-4111-8111-111111111111" },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await creditAppStoreTransaction(
      "22222222-2222-4222-8222-222222222222",
      "tx-1",
    );

    expect(result).toEqual({ status: "invalid", reason: "wrong_owner" });
    expect(grantTickets).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("credits a purchase whose token matches, case-insensitively", async () => {
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, appAccountToken: "AAAAAAAA-1111-4111-8111-111111111111" },
    });
    grantTickets.mockResolvedValue(3);

    const result = await creditAppStoreTransaction(
      "aaaaaaaa-1111-4111-8111-111111111111",
      "tx-1",
    );

    expect(result).toMatchObject({ status: "credited" });
  });

  it("credits a purchase made under the buyer's derived appAccountToken (GET /v1/me)", async () => {
    const buyer = "33333333-3333-4333-8333-333333333333";
    const { appAccountTokenFor } = await import("./appstore.js");
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, appAccountToken: appAccountTokenFor(buyer).toUpperCase() },
    });
    grantTickets.mockResolvedValue(3);

    await expect(creditAppStoreTransaction(buyer, "tx-1")).resolves.toMatchObject({
      status: "credited",
    });
  });

  it("refuses another user's derived token", async () => {
    const { appAccountTokenFor } = await import("./appstore.js");
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: {
        ...okTx,
        appAccountToken: appAccountTokenFor("44444444-4444-4444-8444-444444444444"),
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      creditAppStoreTransaction("33333333-3333-4333-8333-333333333333", "tx-1"),
    ).resolves.toEqual({ status: "invalid", reason: "wrong_owner" });
    error.mockRestore();
  });

  it("still credits a build that predates the token", async () => {
    // Refusing these would break purchases already in the wild, so the check is
    // "verify when present", not "require".
    getVerifiedTransaction.mockResolvedValue({
      status: "ok",
      transaction: { ...okTx, appAccountToken: null },
    });
    grantTickets.mockResolvedValue(3);

    const result = await creditAppStoreTransaction("any-user", "tx-1");

    expect(result).toMatchObject({ status: "credited" });
  });

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

describe("reverseAppStoreTicketRefund (REFUND_REVERSED)", () => {
  it("re-credits exactly what the refund clawed back, keyed for exactly-once", async () => {
    // The refund row: 2 of a 3-bundle were still in the wallet (1 was spent).
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: -2 });
    grantTickets.mockResolvedValue(7);

    await expect(reverseAppStoreTicketRefund(okTx)).resolves.toEqual({
      status: "restored",
      restored: 2,
      balance: 7,
    });
    expect(ledgerFindUnique).toHaveBeenCalledWith({
      where: { externalPaymentId: "appstore:tx-1:refund" },
      select: { userId: true, delta: true },
    });
    expect(grantTickets).toHaveBeenCalledWith({
      userId: "u1",
      count: 2,
      reason: "refund_reversed",
      externalPaymentId: "appstore:tx-1:refund_reversed",
    });
  });

  it("a redelivered reversal credits nothing a second time", async () => {
    ledgerFindUnique.mockResolvedValue({ userId: "u1", delta: -3 });
    grantTickets.mockRejectedValue({ code: "P2002" });

    await expect(reverseAppStoreTicketRefund(okTx)).resolves.toEqual({
      status: "already_restored",
    });
  });

  it("restores nothing while Apple still reports the transaction revoked", async () => {
    await expect(
      reverseAppStoreTicketRefund({ ...okTx, revocationDate: 123 }),
    ).resolves.toEqual({ status: "still_revoked" });
    expect(ledgerFindUnique).not.toHaveBeenCalled();
    expect(grantTickets).not.toHaveBeenCalled();
  });

  it("restores nothing when no refund was ever applied, or the refund took nothing", async () => {
    ledgerFindUnique.mockResolvedValueOnce(null);
    await expect(reverseAppStoreTicketRefund(okTx)).resolves.toEqual({ status: "no_refund" });

    ledgerFindUnique.mockResolvedValueOnce({ userId: "u1", delta: 0 });
    await expect(reverseAppStoreTicketRefund(okTx)).resolves.toEqual({
      status: "nothing_taken",
    });
    expect(grantTickets).not.toHaveBeenCalled();
  });
});
