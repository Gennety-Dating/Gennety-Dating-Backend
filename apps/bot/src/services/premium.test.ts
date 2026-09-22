import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const ledgerCreate = vi.fn();
const ledgerUpdate = vi.fn();
const ledgerFindUnique = vi.fn();
const ledgerFindMany = vi.fn();
const queryRawUnsafe = vi.fn();
const transaction = vi.fn();

const prismaMock = {
  user: { findUnique: userFindUnique, update: userUpdate },
  subscriptionLedger: {
    create: ledgerCreate,
    update: ledgerUpdate,
    findUnique: ledgerFindUnique,
    findMany: ledgerFindMany,
  },
  $queryRawUnsafe: queryRawUnsafe,
  $transaction: transaction,
};

vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return { ...actual, prisma: prismaMock };
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
  recordPremiumLapse,
  premiumUntilAfterRefund,
  recurringPremiumUntil,
  hasLiveRecurringPremium,
  shouldDeclineRecurringCheckout,
  addMonths,
} = await import("./premium.js");

const DAY = 24 * 60 * 60 * 1000;

const NOW = new Date("2026-07-20T12:00:00Z");
const FUTURE = new Date("2026-08-19T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  notifyFounderPurchase.mockReset();
  // Reset, not just clear: the ledger insert now runs before the head update,
  // so a test whose insert throws leaves its queued `update` value unconsumed,
  // and a cleared-but-queued value would leak into the next test.
  for (const fn of [
    userFindUnique,
    userUpdate,
    ledgerCreate,
    ledgerUpdate,
    ledgerFindUnique,
    ledgerFindMany,
    queryRawUnsafe,
  ]) {
    fn.mockReset();
  }
  ledgerFindUnique.mockResolvedValue(null);
  ledgerFindMany.mockResolvedValue([]);
  queryRawUnsafe.mockResolvedValue([]);
  // Array form resolves every op (a rejected create surfaces P2002); callback
  // form runs against the same mock, the way an interactive transaction does.
  transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
      : Promise.all(arg as Promise<unknown>[]),
  );
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
  /**
   * A13-H2. A refund used to write `premiumUntil: null`, confiscating every
   * month the user held from elsewhere — a 6-month Stars package, a referral
   * month — along with the refunded charge. Only the refunded period's unused
   * part comes back now.
   */
  it("subtracts only the refunded period's unused coverage", async () => {
    const now = Date.now();
    const refundedEnd = new Date(now + 20 * DAY);
    const stacked = new Date(now + 200 * DAY); // subscription + a 6-month package
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: stacked });
    userUpdate.mockResolvedValueOnce({});
    ledgerCreate.mockResolvedValueOnce({ id: "l2" });

    await revokePremium({
      userId: "u1",
      externalPaymentId: "appstore:tx-2:refund",
      provider: "app_store",
      refunded: { start: new Date(now - 10 * DAY), end: refundedEnd },
    });

    const data = userUpdate.mock.calls[0][0].data;
    expect(data.premiumAutoRenew).toBe(false);
    const written = (data.premiumUntil as Date).getTime();
    // 200 days held − the 20 unused days of the refunded month = ~180 left.
    expect(written).toBeGreaterThan(now + 179 * DAY);
    expect(written).toBeLessThan(now + 181 * DAY);
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), "u1");
    expect(ledgerCreate.mock.calls[0][0].data).toMatchObject({
      event: "refunded",
      provider: "app_store",
      externalPaymentId: "appstore:tx-2:refund",
    });
  });

  it("swallows a duplicate revoke (P2002)", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: FUTURE });
    ledgerCreate.mockRejectedValueOnce({ code: "P2002" });
    await expect(
      revokePremium({
        userId: "u1",
        externalPaymentId: "refund-1",
        provider: "app_store",
        refunded: { start: null, end: FUTURE },
      }),
    ).resolves.toBeUndefined();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("premiumUntilAfterRefund", () => {
  const now = new Date("2026-09-14T12:00:00Z");

  it("ends access when the refunded period was all that was left", () => {
    const end = new Date(now.getTime() + 20 * DAY);
    expect(premiumUntilAfterRefund(end, { start: new Date(now.getTime() - 10 * DAY), end }, now))
      .toBeNull();
  });

  it("keeps a period that had not started from being counted as used", () => {
    // A renewal refunded before its period began: all of it is unused.
    const start = new Date(now.getTime() + 5 * DAY);
    const end = new Date(now.getTime() + 35 * DAY);
    const stored = new Date(now.getTime() + 65 * DAY);
    expect(premiumUntilAfterRefund(stored, { start, end }, now)).toEqual(
      new Date(now.getTime() + 35 * DAY),
    );
  });

  it("changes nothing for a refund whose period already ran out", () => {
    const stored = new Date(now.getTime() + 30 * DAY);
    const end = new Date(now.getTime() - DAY);
    expect(premiumUntilAfterRefund(stored, { start: null, end }, now)).toEqual(stored);
  });
});

describe("recordPremiumLapse", () => {
  // A13-H2: the lapse must not shorten `premiumUntil` — entitlement is
  // date-based already, and the head also carries months the lapsed
  // subscription never bought.
  it("turns auto-renew off and never touches premiumUntil", async () => {
    ledgerCreate.mockResolvedValueOnce({});
    userUpdate.mockResolvedValueOnce({});
    await recordPremiumLapse("u1", "appstore:tx-1:expired", "app_store");
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { premiumAutoRenew: false },
    });
    expect(ledgerCreate.mock.calls[0][0].data).toMatchObject({ event: "expired" });
  });

  it("is idempotent on a redelivered lapse (P2002)", async () => {
    ledgerCreate.mockRejectedValueOnce({ code: "P2002" });
    userUpdate.mockResolvedValueOnce({});
    await expect(
      recordPremiumLapse("u1", "appstore:tx-1:expired", "app_store"),
    ).resolves.toBeUndefined();
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
    // The hazard long packages introduce. A monthly subscriber who buys 6
    // months has `premiumUntil` half a year out; their next ordinary 30-day
    // renewal carries a `subscription_expiration_date` ~30 days out. Writing
    // that through would silently delete five months of paid access on a
    // charge the user just made.
    const farFuture = new Date(Date.now() + 180 * DAY);
    userFindUnique.mockResolvedValueOnce({ premiumSince: NOW, premiumUntil: farFuture });
    userUpdate.mockReturnValueOnce({ premiumUntil: farFuture });
    ledgerCreate.mockReturnValueOnce({});

    await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: new Date(Date.now() + 30 * DAY),
      externalPaymentId: "renewal_charge",
      event: "renewed",
    });

    const written = userUpdate.mock.calls[0][0].data.premiumUntil as Date;
    expect(written.getTime()).toBeGreaterThanOrEqual(farFuture.getTime());
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

/**
 * A13-M26. `max(stored, periodEnd)` made a renewal swallow time the
 * subscription never bought: a subscriber holding a referral month renewed and
 * came out with the same date they would have had without the month.
 */
describe("recurring grants keep the time the subscription did not buy", () => {
  it("a renewal adds its period ON TOP of a referral month", async () => {
    const now = Date.now();
    const previousEnd = new Date(now + 2 * DAY); // current Stars period
    const withReferral = new Date(previousEnd.getTime() + 30 * DAY);
    const renewedEnd = new Date(previousEnd.getTime() + 30 * DAY);
    userFindUnique.mockResolvedValueOnce({
      premiumSince: NOW,
      premiumUntil: withReferral,
      premiumExternalId: "charge-prev",
    });
    ledgerFindUnique.mockResolvedValueOnce({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: previousEnd,
    });
    ledgerCreate.mockResolvedValueOnce({});
    userUpdate.mockImplementationOnce(async (arg: { data: { premiumUntil: Date } }) => ({
      premiumUntil: arg.data.premiumUntil,
    }));

    const res = await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: renewedEnd,
      externalPaymentId: "charge-next",
      event: "renewed",
    });

    // Renewed period + the referral month, not just the renewed period.
    expect(res.premiumUntil).toEqual(new Date(renewedEnd.getTime() + 30 * DAY));
    expect(ledgerFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalPaymentId: "charge-prev" } }),
    );
  });

  it("takes the row lock before reading the head it computes from", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: null });
    ledgerCreate.mockResolvedValueOnce({});
    userUpdate.mockResolvedValueOnce({ premiumUntil: FUTURE });

    await activateOrExtendPremium({
      userId: "u1",
      provider: "telegram_stars",
      periodEnd: FUTURE,
      externalPaymentId: "charge-lock",
    });

    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), "u1");
    expect(queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      userFindUnique.mock.invocationCallOrder[0]!,
    );
  });

  it("skips a refunded App Store period when finding the one being renewed", async () => {
    const now = Date.now();
    const live = new Date(now + DAY);
    ledgerFindMany
      .mockResolvedValueOnce([
        { externalPaymentId: "appstore:tx-3", periodEnd: new Date(now + 10 * DAY) },
        { externalPaymentId: "appstore:tx-2", periodEnd: live },
      ])
      .mockResolvedValueOnce([{ externalPaymentId: "appstore:tx-3:refund" }]);
    userFindUnique.mockResolvedValueOnce({
      premiumSince: NOW,
      premiumUntil: new Date(now + 31 * DAY), // live period + 30 comp days
      premiumExternalId: "orig-1",
    });
    ledgerCreate.mockResolvedValueOnce({});
    userUpdate.mockImplementationOnce(async (arg: { data: { premiumUntil: Date } }) => ({
      premiumUntil: arg.data.premiumUntil,
    }));
    const periodEnd = new Date(live.getTime() + 30 * DAY);

    const res = await activateOrExtendPremium({
      userId: "u1",
      provider: "app_store",
      periodEnd,
      externalPaymentId: "appstore:tx-4",
      recurringAnchor: "orig-1",
    });

    expect(res.premiumUntil).toEqual(new Date(periodEnd.getTime() + 30 * DAY));
  });
});

describe("recurringPremiumUntil", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  it("gives a pure subscription exactly what max(stored, periodEnd) gave", () => {
    // Renewal at the period boundary, first activation, and a lapsed head.
    expect(
      recurringPremiumUntil({ storedUntil: at(1), periodEnd: at(31), previousPeriodEnd: at(1), now }),
    ).toEqual(at(31));
    expect(
      recurringPremiumUntil({ storedUntil: null, periodEnd: at(30), previousPeriodEnd: null, now }),
    ).toEqual(at(30));
    expect(
      recurringPremiumUntil({ storedUntil: at(-5), periodEnd: at(30), previousPeriodEnd: at(-5), now }),
    ).toEqual(at(30));
  });

  it("counts a first subscription's extra from now", () => {
    // 90 package days left, then subscribes: 30 + 90.
    expect(
      recurringPremiumUntil({ storedUntil: at(90), periodEnd: at(30), previousPeriodEnd: null, now }),
    ).toEqual(at(120));
  });

  it("does not bank days of an old subscription that already ran out", () => {
    // Old subscription ended 60 days ago; a package runs 90 more days.
    expect(
      recurringPremiumUntil({
        storedUntil: at(90),
        periodEnd: at(30),
        previousPeriodEnd: at(-60),
        now,
      }),
    ).toEqual(at(120));
  });

  it("lands a stale charge for an already-covered period as a no-op, never a cut", () => {
    expect(
      recurringPremiumUntil({ storedUntil: at(60), periodEnd: at(30), previousPeriodEnd: at(60), now }),
    ).toEqual(at(60));
  });
});

describe("hasLiveRecurringPremium", () => {
  it("is true only for an active period that renews itself", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const later = new Date("2026-10-14T12:00:00Z");
    expect(hasLiveRecurringPremium({ premiumUntil: later, premiumAutoRenew: true }, now)).toBe(true);
    // A package buyer or a cancelled subscriber: nothing renews.
    expect(hasLiveRecurringPremium({ premiumUntil: later, premiumAutoRenew: false }, now)).toBe(
      false,
    );
    // Lapsed: the flag alone proves nothing.
    expect(hasLiveRecurringPremium({ premiumUntil: now, premiumAutoRenew: true }, now)).toBe(false);
    expect(hasLiveRecurringPremium(null, now)).toBe(false);
  });
});

describe("shouldDeclineRecurringCheckout", () => {
  const head = (over: Record<string, unknown> = {}) => ({
    premiumUntil: new Date(Date.now() + 20 * DAY),
    premiumAutoRenew: true,
    premiumProvider: "telegram_stars",
    premiumExternalId: "charge-live",
    ...over,
  });

  it("declines a second Stars subscription mid-period", async () => {
    userFindUnique.mockResolvedValueOnce(head());
    ledgerFindUnique.mockResolvedValueOnce({ periodEnd: new Date(Date.now() + 20 * DAY) });
    await expect(shouldDeclineRecurringCheckout(1n)).resolves.toBe(true);
  });

  it("never declines inside the last stretch of the period, where a renewal would sit", async () => {
    userFindUnique.mockResolvedValueOnce(head());
    ledgerFindUnique.mockResolvedValueOnce({ periodEnd: new Date(Date.now() + 60 * 60 * 1000) });
    await expect(shouldDeclineRecurringCheckout(1n)).resolves.toBe(false);
  });

  it("approves when the current Stars period cannot be found", async () => {
    userFindUnique.mockResolvedValueOnce(head());
    ledgerFindUnique.mockResolvedValueOnce(null);
    await expect(shouldDeclineRecurringCheckout(1n)).resolves.toBe(false);
  });

  it("declines a Stars subscription on top of a live App Store one", async () => {
    userFindUnique.mockResolvedValueOnce(head({ premiumProvider: "app_store" }));
    await expect(shouldDeclineRecurringCheckout(1n)).resolves.toBe(true);
    expect(ledgerFindUnique).not.toHaveBeenCalled();
  });

  it("approves a cancelled or package-only head", async () => {
    userFindUnique.mockResolvedValueOnce(head({ premiumAutoRenew: false }));
    await expect(shouldDeclineRecurringCheckout(1n)).resolves.toBe(false);
  });
});

describe("addMonths", () => {
  // A13-M26: `setMonth` overflowed, so Jan 31 + 1 month was Mar 3.
  it("clamps to the last day of the target month", () => {
    expect(addMonths(new Date(2027, 0, 31, 12), 1)).toEqual(new Date(2027, 1, 28, 12));
    expect(addMonths(new Date(2028, 0, 31, 12), 1)).toEqual(new Date(2028, 1, 29, 12));
    expect(addMonths(new Date(2026, 7, 31, 9, 30), 6)).toEqual(new Date(2027, 1, 28, 9, 30));
  });

  it("keeps the day of month when it exists", () => {
    expect(addMonths(new Date(2026, 8, 14, 8), 3)).toEqual(new Date(2026, 11, 14, 8));
    expect(addMonths(new Date(2026, 10, 30), 3)).toEqual(new Date(2027, 1, 28));
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
    const expected = addMonths(liveUntil, 3);

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
  // A13-M26: the additive write was read-modify-write outside any lock, so two
  // concurrent grants both stacked onto the same old head and one was lost.
  it("reads the head under the row lock, inside the transaction", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await grantComplimentaryPremiumMonths({
      userId: "u1",
      months: 1,
      externalPaymentId: "promo:c1:u1:premium",
      provider: "promo",
    });

    expect(transaction.mock.calls[0]![0]).toBeTypeOf("function");
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), "u1");
    expect(queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      userFindUnique.mock.invocationCallOrder[0]!,
    );
  });

  it("stays a comp: no money on the ledger row, no founder announcement", async () => {
    userFindUnique.mockResolvedValueOnce({ premiumSince: null, premiumUntil: null });
    userUpdate.mockReturnValueOnce({ premiumUntil: FUTURE });
    ledgerCreate.mockReturnValueOnce({});

    await grantComplimentaryPremiumMonths({
      userId: "u1",
      months: 1,
      externalPaymentId: "promo:c2:u1:premium",
      provider: "promo",
    });

    expect(ledgerCreate.mock.calls[0][0].data).toMatchObject({
      provider: "promo",
      amount: null,
      currency: null,
    });
    expect(notifyFounderPurchase).not.toHaveBeenCalled();
  });
});
