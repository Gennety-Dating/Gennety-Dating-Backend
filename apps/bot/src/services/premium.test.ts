import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const ledgerCreate = vi.fn();
const transaction = vi.fn();

vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return {
    ...actual,
    prisma: {
      user: { findUnique: userFindUnique, update: userUpdate },
      subscriptionLedger: { create: ledgerCreate },
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
