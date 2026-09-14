import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn(), updateMany: vi.fn() },
    primeTimePurchase: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback((await import("@gennety/db")).prisma),
    ),
  },
}));

vi.mock("../config.js", () => ({
  env: {
    PRIME_TIME_ENABLED: true,
    PREMIUM_FEATURE_ENABLED: true,
    PRIME_TIME_SLOT_COUNT: 3,
    PRIME_TIME_STARS: 50,
    PRIME_TIME_APPSTORE_ENABLED: true,
    PRIME_TIME_APPSTORE_PRODUCT_ID: "prime_time_pass",
    APPSTORE_BUNDLE_ID: "com.gennety.ios",
  },
}));

const getVerifiedTransaction = vi.fn();
vi.mock("./appstore.js", () => ({
  appStoreConfigured: () => true,
  getVerifiedTransaction: (...a: unknown[]) => getVerifiedTransaction(...a),
}));

vi.mock("./founder-notify.js", () => ({
  notifyFounderPurchase: vi.fn(),
  notifyFounderPurchaseRefunded: vi.fn(),
  notifyFounderAppStoreUnclaimed: vi.fn(),
}));

vi.mock("./main-bot-api.js", () => ({ getMainBotApi: () => null }));

const { prisma } = await import("@gennety/db");
const {
  purchasePrimeTimePass,
  refundPrimeTimeAppStoreTransaction,
} = await import("./appstore-prime-time.js");
const founder = await import("./founder-notify.js");
const { appStoreManualRefundNote, appStoreManualRefundReason } = await import(
  "./prime-time-purchase.js"
);
const { wallToUtc } = await import("./profiler-schedule.js");

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  match: { findUnique: MockFn; updateMany: MockFn };
  primeTimePurchase: { create: MockFn; findUnique: MockFn; findMany: MockFn; updateMany: MockFn };
  $transaction: MockFn;
};

const BUYER = "11111111-1111-4111-8111-111111111111";
const PARTNER = "22222222-2222-4222-8222-222222222222";
const MATCH = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-14T10:00:00.000Z");

function fakeApi() {
  return { sendMessage: vi.fn().mockResolvedValue({}) } as unknown as Parameters<
    typeof purchasePrimeTimePass
  >[0] & { sendMessage: MockFn };
}

function appleTx(over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    transaction: {
      transactionId: "2000000999",
      originalTransactionId: "2000000999",
      bundleId: "com.gennety.ios",
      productId: "com.gennety.ios.prime_time_pass",
      quantity: 1,
      revocationDate: null,
      expiresDate: null,
      purchaseDate: NOW.getTime(),
      environment: "Sandbox",
      priceCents: 99,
      currency: "USD",
      appAccountToken: null,
      ...over,
    },
  };
}

function person(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    telegramId: -7n,
    platform: "mobile",
    premiumUntil: null,
    firstName: id === BUYER ? "Lena" : "Artem",
    language: "en",
    ...over,
  };
}

function matchRow(over: Record<string, unknown> = {}) {
  return {
    id: MATCH,
    status: "negotiating",
    userAId: BUYER,
    userBId: PARTNER,
    primeTimeUnlockedAt: null,
    availableTimesA: [] as Date[],
    availableTimesB: [] as Date[],
    userA: person(BUYER),
    userB: person(PARTNER),
    ...over,
  };
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  vi.clearAllMocks();
  getVerifiedTransaction.mockResolvedValue(appleTx());
  db.primeTimePurchase.create.mockResolvedValue({ id: "p1" });
  db.primeTimePurchase.updateMany.mockResolvedValue({ count: 1 });
  db.match.findUnique.mockResolvedValue(matchRow());
  db.match.updateMany.mockResolvedValue({ count: 1 });
});

describe("purchasePrimeTimePass — the first report", () => {
  it("writes the row, opens the band for the pair and settles in one transaction", async () => {
    const api = fakeApi();
    const res = await purchasePrimeTimePass(api, BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "settled" });
    expect(db.primeTimePurchase.create).toHaveBeenCalledWith({
      data: {
        userId: BUYER,
        matchId: MATCH,
        status: "processing",
        externalPaymentId: "appstore:2000000999",
        amountStars: 0,
      },
      select: { id: true },
    });
    expect(db.match.updateMany).toHaveBeenCalledWith({
      where: { id: MATCH, status: "negotiating", primeTimeUnlockedAt: null },
      data: { primeTimeUnlockedAt: expect.any(Date), primeTimePaidById: BUYER },
    });
    expect(db.primeTimePurchase.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: "processing" },
      data: { status: "settled", resolvedAt: expect.any(Date) },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(founder.notifyFounderPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prime_time",
        provider: "app_store",
        amountCents: 99,
        sandbox: true,
        externalPaymentId: "appstore:2000000999",
      }),
    );
    // An app-only partner gets no Telegram DM — they see the band on the next poll.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("tells a Telegram partner why their grid changed", async () => {
    db.match.findUnique.mockResolvedValue(
      matchRow({ userB: person(PARTNER, { telegramId: 555n, platform: "telegram" }) }),
    );
    const api = fakeApi();

    await purchasePrimeTimePass(api, BUYER, MATCH, "2000000999", NOW);

    expect(api.sendMessage).toHaveBeenCalledWith(555, expect.stringContaining("Lena"));
  });

  it.each([
    ["wrong_bundle", { bundleId: "com.someone.else" }],
    ["revoked", { revocationDate: NOW.getTime() }],
    ["wrong_owner", { appAccountToken: "99999999-9999-4999-8999-999999999999" }],
    ["unknown_product", { productId: "com.gennety.ios.venue_change_1" }],
  ])("rejects %s before writing anything", async (reason, over) => {
    getVerifiedTransaction.mockResolvedValue(appleTx(over));

    const res = await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "invalid", reason });
    expect(db.primeTimePurchase.create).not.toHaveBeenCalled();
    expect(db.match.updateMany).not.toHaveBeenCalled();
  });

  it("accepts an appAccountToken that names the buyer", async () => {
    getVerifiedTransaction.mockResolvedValue(appleTx({ appAccountToken: BUYER.toUpperCase() }));
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "settled",
    });
  });

  it("answers unavailable when Apple is down, and unknown_transaction when Apple has no such id", async () => {
    getVerifiedTransaction.mockResolvedValueOnce({ status: "unavailable" });
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "x", NOW)).toEqual({
      status: "unavailable",
    });
    getVerifiedTransaction.mockResolvedValueOnce({ status: "not_found" });
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "x", NOW)).toEqual({
      status: "invalid",
      reason: "unknown_transaction",
    });
    expect(db.primeTimePurchase.create).not.toHaveBeenCalled();
  });
});

describe("purchasePrimeTimePass — charged, but nothing to buy (R2)", () => {
  function expectParked(reason: string) {
    const write = db.primeTimePurchase.updateMany.mock.calls.at(-1)?.[0] as {
      where: unknown;
      data: { status: string; refundError: string };
    };
    expect(write.where).toEqual({ id: "p1", status: "processing" });
    expect(write.data.status).toBe("refund_manual");
    expect(appStoreManualRefundReason(write.data.refundError)).toBe(reason);
    expect(write.data.refundError).toContain("appstore:2000000999");
    expect(founder.notifyFounderAppStoreUnclaimed).toHaveBeenCalledWith(
      expect.objectContaining({ reason, externalPaymentId: "appstore:2000000999", matchId: MATCH }),
    );
    expect(founder.notifyFounderPurchase).not.toHaveBeenCalled();
  }

  it("parks it when the partner's Premium already opens the band", async () => {
    db.match.findUnique.mockResolvedValue(
      matchRow({ userB: person(PARTNER, { premiumUntil: new Date(NOW.getTime() + 86_400_000) }) }),
    );

    const res = await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "unclaimed", reason: "already_unlocked" });
    expect(db.match.updateMany).not.toHaveBeenCalled();
    expectParked("already_unlocked");
  });

  it("parks it when the partner's pass got there first", async () => {
    db.match.findUnique.mockResolvedValue(matchRow({ primeTimeUnlockedAt: new Date(NOW) }));

    const res = await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "unclaimed", reason: "already_unlocked" });
    expectParked("already_unlocked");
  });

  it("parks it when the pair already holds an evening (grandfathered)", async () => {
    const evening = wallToUtc(2026, 9, 16, 19, 30, "Europe/Kyiv");
    db.match.findUnique.mockResolvedValue(matchRow({ availableTimesB: [evening] }));

    const res = await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "unclaimed", reason: "already_unlocked" });
    expectParked("already_unlocked");
  });

  it("parks it when the claim loses the race (count 0)", async () => {
    db.match.updateMany.mockResolvedValue({ count: 0 });

    const res = await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "unclaimed", reason: "already_unlocked" });
    expectParked("already_unlocked");
  });

  it("parks it when the pair is no longer negotiating", async () => {
    db.match.findUnique.mockResolvedValue(matchRow({ status: "negotiating_venue" }));

    const res = await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW);

    expect(res).toEqual({ status: "unclaimed", reason: "match_closed" });
    expect(db.match.updateMany).not.toHaveBeenCalled();
    expectParked("match_closed");
  });

  it("parks it when the buyer is not in the match, or the match is gone", async () => {
    db.match.findUnique.mockResolvedValue(
      matchRow({ userAId: "44444444-4444-4444-8444-444444444444" }),
    );
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "unclaimed",
      reason: "not_participant",
    });
    expectParked("not_participant");

    vi.clearAllMocks();
    getVerifiedTransaction.mockResolvedValue(appleTx());
    db.primeTimePurchase.create.mockResolvedValue({ id: "p1" });
    db.primeTimePurchase.updateMany.mockResolvedValue({ count: 1 });
    db.match.findUnique.mockResolvedValue(null);
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "unclaimed",
      reason: "not_participant",
    });
    expectParked("not_participant");
  });
});

describe("purchasePrimeTimePass — a re-report gets the first report's answer", () => {
  beforeEach(() => {
    db.primeTimePurchase.create.mockRejectedValue(uniqueViolation());
  });

  function existing(over: Record<string, unknown> = {}) {
    return {
      id: "p1",
      userId: BUYER,
      matchId: MATCH,
      status: "settled",
      refundError: null,
      createdAt: new Date(NOW.getTime() - 60_000),
      ...over,
    };
  }

  it("200 again after settled — and opens nothing twice", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue(existing());

    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "settled",
    });
    expect(db.match.updateMany).not.toHaveBeenCalled();
    expect(founder.notifyFounderPurchase).not.toHaveBeenCalled();
  });

  it("the same 409 code after refund_manual — and no second alert", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue(
      existing({
        status: "refund_manual",
        refundError: appStoreManualRefundNote("match_closed", "appstore:2000000999"),
      }),
    );

    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "unclaimed",
      reason: "match_closed",
    });
    expect(founder.notifyFounderAppStoreUnclaimed).not.toHaveBeenCalled();
  });

  it("200 for a pass that settled and was parked later because the date died", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue(
      existing({
        status: "refund_manual",
        refundError: appStoreManualRefundNote("match_died", "appstore:2000000999"),
      }),
    );
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "settled",
    });
  });

  it("refuses another account re-sending someone else's transaction", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue(existing({ userId: PARTNER }));
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "invalid",
      reason: "wrong_owner",
    });
  });

  it("503 while the first report is still in flight", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue(existing({ status: "processing" }));
    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "unavailable",
    });
    expect(db.match.updateMany).not.toHaveBeenCalled();
  });

  it("finishes a settle the first report abandoned — nothing else ever will", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue(
      existing({ status: "processing", createdAt: new Date(NOW.getTime() - 10 * 60_000) }),
    );

    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "settled",
    });
    expect(db.match.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a resume that loses to a concurrent resume answers from the row, not a refund", async () => {
    db.primeTimePurchase.findUnique
      .mockResolvedValueOnce(
        existing({ status: "processing", createdAt: new Date(NOW.getTime() - 10 * 60_000) }),
      )
      .mockResolvedValueOnce(existing({ status: "settled" }));
    // The other request claimed the band and settled the row first.
    db.match.updateMany.mockResolvedValue({ count: 0 });
    db.primeTimePurchase.updateMany.mockResolvedValue({ count: 0 });

    expect(await purchasePrimeTimePass(fakeApi(), BUYER, MATCH, "2000000999", NOW)).toEqual({
      status: "settled",
    });
    expect(founder.notifyFounderAppStoreUnclaimed).not.toHaveBeenCalled();
  });
});

describe("refundPrimeTimeAppStoreTransaction — Apple gave the money back (R6)", () => {
  const revoked = () => appleTx({ revocationDate: NOW.getTime() }).transaction as never;

  it("records refunded_appstore, tells the founder, and leaves the band open", async () => {
    db.primeTimePurchase.findUnique.mockResolvedValue({ id: "p1", userId: BUYER, status: "settled" });

    expect(await refundPrimeTimeAppStoreTransaction(revoked())).toEqual({ status: "recorded" });

    expect(db.primeTimePurchase.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: "settled" },
      data: { status: "refunded_appstore", resolvedAt: expect.any(Date) },
    });
    expect(db.match.updateMany).not.toHaveBeenCalled();
    expect(founder.notifyFounderPurchaseRefunded).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "prime_time", externalPaymentId: "appstore:2000000999" }),
    );
  });

  it("ignores a notification without a revocation, an unknown purchase and a repeat", async () => {
    expect(
      await refundPrimeTimeAppStoreTransaction(appleTx().transaction as never),
    ).toEqual({ status: "not_revoked" });

    db.primeTimePurchase.findUnique.mockResolvedValueOnce(null);
    expect(await refundPrimeTimeAppStoreTransaction(revoked())).toEqual({ status: "no_purchase" });

    db.primeTimePurchase.findUnique.mockResolvedValueOnce({
      id: "p1",
      userId: BUYER,
      status: "refunded_appstore",
    });
    expect(await refundPrimeTimeAppStoreTransaction(revoked())).toEqual({
      status: "already_recorded",
    });
    expect(founder.notifyFounderPurchaseRefunded).not.toHaveBeenCalled();
  });
});
