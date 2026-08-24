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

const notifyFounderPurchase = vi.fn();
vi.mock("./founder-notify.js", () => ({ notifyFounderPurchase }));

const {
  isPremiumHeadActive,
  isPremiumActive,
  getPremiumState,
  activateOrExtendPremium,
  activatePremiumPackage,
  grantComplimentaryPremiumMonths,
  revokePremium,
  getPremiumCancelContext,
  recordInChatCancellation,
  attachCancellationReason,
} = await import("./premium.js");

const NOW = new Date("2026-07-20T12:00:00Z");
const FUTURE = new Date("2026-08-19T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  notifyFounderPurchase.mockReset();
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


describe("the monotonic guard on a paid grant", () => {
  it("never moves premiumUntil BACKWARD on a renewal", async () => {
    // The hazard long packages introduce, and the reason this guard exists at
    // all. A monthly subscriber who buys 6 months has `premiumUntil` half a
    // year out; their next ordinary 30-day renewal carries a
    // `subscription_expiration_date` ~30 days out. Writing that through would
    // silently delete five months of paid access on a charge the user just
    // made.
    const farFuture = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: farFuture });
    userUpdate.mockReturnValueOnce({ premiumUntil: farFuture });
    ledgerCreate.mockReturnValueOnce({});

    await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: FUTURE, // ~30 days out — EARLIER than what the user holds
      externalPaymentId: "renewal_charge",
      event: "renewed",
    });

    expect(userUpdate.mock.calls[0][0].data.premiumUntil).toEqual(farFuture);
  });

  it("still extends when the new period genuinely is later", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: NOW });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: FUTURE,
      externalPaymentId: "charge_next",
    });

    expect(userUpdate.mock.calls[0][0].data.premiumUntil).toEqual(FUTURE);
  });

  it("clears both expiry-reminder markers — a new period earns new warnings", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: FUTURE,
      externalPaymentId: "charge_first",
    });

    expect(userUpdate.mock.calls[0][0].data).toMatchObject({
      premiumReminder3dAt: null,
      premiumReminder1dAt: null,
    });
  });
});

describe("activatePremiumPackage", () => {
  it("STACKS onto a live period instead of replacing it", async () => {
    // "новый срок прибавляется к текущей дате окончания" — a user who buys 3
    // months with a month still running gets four, not three.
    //
    // The base is derived from the wall clock inside the service, so the
    // fixture is anchored to `Date.now()` rather than to a literal: a hardcoded
    // date silently stops being "in the future" as the calendar moves past it,
    // and the test then passes for the wrong reason (falling into the
    // already-lapsed branch it is meant to distinguish from).
    const liveUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expected = new Date(liveUntil);
    expected.setMonth(expected.getMonth() + 3);

    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: liveUntil });
    userUpdate.mockReturnValueOnce({ premiumUntil: expected });
    ledgerCreate.mockReturnValueOnce({});

    await activatePremiumPackage({
      userId: "u1",
      months: 3,
      externalPaymentId: "pkg_charge_1",
      amount: 1912,
      currency: "XTR",
    });

    // Base is the EXISTING expiry, not now.
    expect(userUpdate.mock.calls[0][0].data.premiumUntil).toEqual(expected);
    expect(ledgerCreate.mock.calls[0][0].data).toMatchObject({
      provider: "telegram_stars",
      event: "started",
      amount: 1912,
      currency: "XTR",
      periodStart: liveUntil,
    });
  });

  it("counts from NOW when the previous period already lapsed", async () => {
    userFindUnique.mockResolvedValueOnce({
      premiumSince: NOW,
      premiumUntil: new Date("2026-01-01T00:00:00Z"),
    });
    userUpdate.mockReturnValueOnce({ premiumUntil: null });
    ledgerCreate.mockReturnValueOnce({});

    await activatePremiumPackage({ userId: "u1", months: 6, externalPaymentId: "pkg_2" });

    const written = userUpdate.mock.calls[0][0].data.premiumUntil as Date;
    // Six months from today, not six months from a date in the past.
    expect(written.getTime()).toBeGreaterThan(Date.now());
  });

  it("NEVER claims the recurring head", async () => {
    // Those three columns describe *the subscription*. Writing them here would
    // either invent a renewal Telegram will never make, or overwrite a live
    // monthly subscriber's cancellation anchor with a charge id that cannot
    // cancel anything.
    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await activatePremiumPackage({ userId: "u1", months: 3, externalPaymentId: "pkg_3" });

    const data = userUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("premiumAutoRenew");
    expect(data).not.toHaveProperty("premiumProvider");
    expect(data).not.toHaveProperty("premiumExternalId");
  });

  it("clears the reminder markers so the package announces its own ending", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await activatePremiumPackage({ userId: "u1", months: 6, externalPaymentId: "pkg_4" });

    expect(userUpdate.mock.calls[0][0].data).toMatchObject({
      premiumReminder3dAt: null,
      premiumReminder1dAt: null,
    });
  });

  it("announces the sale to the founder feed AFTER the ledger insert", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await activatePremiumPackage({
      userId: "u1",
      months: 6,
      externalPaymentId: "pkg_5",
      amount: 3150,
      currency: "XTR",
    });

    expect(notifyFounderPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "premium", amountStars: 3150, userId: "u1" }),
    );
  });

  it("is idempotent on a redelivered charge — no second grant, no second announcement", async () => {
    userFindUnique
      .mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: FUTURE })
      .mockResolvedValueOnce({ premiumUntil: FUTURE });
    transaction.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );

    const result = await activatePremiumPackage({
      userId: "u1",
      months: 3,
      externalPaymentId: "pkg_dup",
    });

    expect(result).toEqual({ applied: false, premiumUntil: FUTURE });
    expect(notifyFounderPurchase).not.toHaveBeenCalled();
  });

  it("refuses a zero/negative month count rather than granting nothing forever", async () => {
    const result = await activatePremiumPackage({
      userId: "u1",
      months: 0,
      externalPaymentId: "pkg_zero",
    });
    expect(result.applied).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("grantComplimentaryPremiumMonths (shares the additive path)", () => {
  it("stays a comp: no money on the ledger row, no founder announcement", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await grantComplimentaryPremiumMonths({
      userId: "u1",
      months: 1,
      externalPaymentId: "referral:u1",
    });

    expect(ledgerCreate.mock.calls[0][0].data).toMatchObject({
      provider: "referral",
      amount: null,
      currency: null,
    });
    expect(notifyFounderPurchase).not.toHaveBeenCalled();
  });
});
