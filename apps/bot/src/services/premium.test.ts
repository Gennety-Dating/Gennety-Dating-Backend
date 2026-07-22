import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const ledgerCreate = vi.fn();
const ledgerUpdate = vi.fn();
const transaction = vi.fn();

vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return {
    ...actual,
    prisma: {
      user: { findUnique: userFindUnique, update: userUpdate },
      subscriptionLedger: { create: ledgerCreate, update: ledgerUpdate },
      $transaction: transaction,
    },
  };
});

const {
  isPremiumHeadActive,
  isPremiumActive,
  getPremiumState,
  activateOrExtendPremium,
  revokePremium,
  getPremiumCancelContext,
  recordInChatCancellation,
  attachCancellationReason,
} = await import("./premium.js");

const NOW = new Date("2026-07-20T12:00:00Z");
const FUTURE = new Date("2026-08-19T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  // Array-form $transaction: resolve every op (a rejected create surfaces P2002).
  transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("isPremiumHeadActive", () => {
  it("is true only while premiumUntil is in the future", () => {
    expect(isPremiumHeadActive({ premiumUntil: FUTURE }, NOW)).toBe(true);
    expect(isPremiumHeadActive({ premiumUntil: new Date("2026-07-01") }, NOW)).toBe(false);
    expect(isPremiumHeadActive({ premiumUntil: null }, NOW)).toBe(false);
    expect(isPremiumHeadActive(null, NOW)).toBe(false);
  });
});

describe("isPremiumActive", () => {
  it("uses a loaded head without querying", async () => {
    expect(await isPremiumActive({ premiumUntil: FUTURE }, NOW)).toBe(true);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("queries by id and returns false for unknown users", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    expect(await isPremiumActive("nobody", NOW)).toBe(false);
  });
});

describe("getPremiumState", () => {
  it("maps the head into a state object", async () => {
    userFindUnique.mockResolvedValueOnce({
      premiumUntil: FUTURE,
      premiumSince: NOW,
      premiumProvider: "telegram_stars",
      premiumAutoRenew: true,
    });
    const state = await getPremiumState("u1", NOW);
    expect(state).toEqual({
      active: true,
      premiumUntil: FUTURE,
      premiumSince: NOW,
      provider: "telegram_stars",
      autoRenew: true,
    });
  });
});

describe("activateOrExtendPremium", () => {
  it("grants and records the ledger for a first period", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null }); // existing head
    userUpdate.mockResolvedValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockResolvedValueOnce({ id: "l1" });

    const res = await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: FUTURE,
      externalPaymentId: "charge-1",
      amount: 500,
      currency: "XTR",
    });

    expect(res).toEqual({ applied: true, premiumUntil: FUTURE });
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          premiumUntil: FUTURE,
          premiumProvider: "telegram_stars",
          premiumAutoRenew: true,
          premiumExternalId: "charge-1",
        }),
      }),
    );
  });

  it("is idempotent on a duplicate charge id (P2002)", async () => {
    userFindUnique
      .mockResolvedValueOnce({ premiumSince: NOW }) // existing head
      .mockResolvedValueOnce({ premiumUntil: FUTURE }); // post-conflict re-read
    userUpdate.mockResolvedValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockRejectedValueOnce({ code: "P2002" });

    const res = await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: FUTURE,
      externalPaymentId: "charge-1",
    });

    expect(res).toEqual({ applied: false, premiumUntil: FUTURE });
  });

  it("returns not-applied for an unknown user", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const res = await activateOrExtendPremium({
      userId: "ghost",
      provider: "app_store",
      periodEnd: FUTURE,
      externalPaymentId: "tx-1",
    });
    expect(res).toEqual({ applied: false, premiumUntil: null });
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("revokePremium", () => {
  it("clears the paid period and auto-renew", async () => {
    userUpdate.mockResolvedValueOnce({});
    ledgerCreate.mockResolvedValueOnce({ id: "l2" });
    await revokePremium("u1", "refund-1", "refunded");
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { premiumUntil: null, premiumAutoRenew: false },
      }),
    );
  });

  it("swallows a duplicate revoke (P2002)", async () => {
    userUpdate.mockResolvedValueOnce({});
    ledgerCreate.mockRejectedValueOnce({ code: "P2002" });
    await expect(revokePremium("u1", "refund-1")).resolves.toBeUndefined();
  });
});

describe("getPremiumCancelContext", () => {
  it("maps the head into the cancel context", async () => {
    userFindUnique.mockResolvedValueOnce({
      premiumUntil: FUTURE,
      premiumProvider: "telegram_stars",
      premiumExternalId: "charge-42",
      premiumAutoRenew: true,
    });
    const cx = await getPremiumCancelContext("u1", NOW);
    expect(cx).toEqual({
      active: true,
      provider: "telegram_stars",
      premiumUntil: FUTURE,
      recurringAnchor: "charge-42",
      autoRenew: true,
    });
  });

  it("is inactive with null anchor for an unknown user", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const cx = await getPremiumCancelContext("nobody", NOW);
    expect(cx.active).toBe(false);
    expect(cx.recurringAnchor).toBeNull();
    expect(cx.provider).toBeNull();
  });
});

describe("recordInChatCancellation", () => {
  it("turns auto-renew off, appends a cancelled row, and returns the ledger id", async () => {
    userUpdate.mockResolvedValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockResolvedValueOnce({ id: "led-1" });
    const res = await recordInChatCancellation("u1", "telegram_stars");
    expect(res).toEqual({ ledgerId: "led-1", premiumUntil: FUTURE });
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { premiumAutoRenew: false } }),
    );
    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          provider: "telegram_stars",
          event: "cancelled",
        }),
      }),
    );
    // The synthetic external id must be unique-per-call (exactly-once ledger).
    const arg = ledgerCreate.mock.calls[0][0];
    expect(arg.data.externalPaymentId).toMatch(/^cancel:u1:/);
  });

  it("defaults a null provider to 'unknown'", async () => {
    userUpdate.mockResolvedValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockResolvedValueOnce({ id: "led-2" });
    await recordInChatCancellation("u1", null);
    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "unknown" }) }),
    );
  });
});

describe("attachCancellationReason", () => {
  it("trims and writes a non-empty reason", async () => {
    ledgerUpdate.mockResolvedValueOnce({});
    await attachCancellationReason("led-1", "  too expensive  ");
    expect(ledgerUpdate).toHaveBeenCalledWith({
      where: { id: "led-1" },
      data: { note: "too expensive" },
    });
  });

  it("skips a blank reason without touching the DB", async () => {
    await attachCancellationReason("led-1", "   ");
    expect(ledgerUpdate).not.toHaveBeenCalled();
  });

  it("swallows a DB error (the cancellation already happened)", async () => {
    ledgerUpdate.mockRejectedValueOnce(new Error("gone"));
    await expect(attachCancellationReason("led-1", "reason")).resolves.toBeUndefined();
  });
});
