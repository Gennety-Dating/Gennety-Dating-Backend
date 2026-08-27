import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn(), updateMany: vi.fn() },
    primeTimePurchase: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../config.js", () => ({
  env: { PRIME_TIME_STARS: 50 },
}));

vi.mock("./founder-notify.js", () => ({
  notifyFounderPurchase: vi.fn(),
  notifyFounderPurchaseRefunded: vi.fn(),
}));

const mainBotApi = { current: null as unknown };
vi.mock("./main-bot-api.js", () => ({
  getMainBotApi: () => mainBotApi.current,
}));

import { prisma } from "@gennety/db";
import {
  settlePrimeTimePayment,
  refundPrimeTimeForDeadMatch,
  sweepPrimeTimeRefunds,
} from "./prime-time-purchase.js";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  match: { findUnique: MockFn; updateMany: MockFn };
  primeTimePurchase: { create: MockFn; update: MockFn; findMany: MockFn };
};

function fakeApi() {
  return {
    refundStarPayment: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as Parameters<typeof sweepPrimeTimeRefunds>[0] & {
    refundStarPayment: MockFn;
    sendMessage: MockFn;
  };
}

const PAYER = { id: "u-a", telegramId: 100n, firstName: "Лена", language: "ru" };
const PEER = { id: "u-b", telegramId: 200n, firstName: "Артём", language: "ru" };

function matchRow(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    status: "negotiating",
    userAId: PAYER.id,
    userBId: PEER.id,
    primeTimeUnlockedAt: null,
    userA: PAYER,
    userB: PEER,
    ...over,
  };
}

beforeEach(() => {
  mainBotApi.current = null;
  for (const fn of [
    db.match.findUnique,
    db.match.updateMany,
    db.primeTimePurchase.create,
    db.primeTimePurchase.update,
    db.primeTimePurchase.findMany,
  ]) {
    fn.mockReset();
  }
  db.primeTimePurchase.update.mockResolvedValue({});
  db.primeTimePurchase.create.mockResolvedValue({
    id: "p1",
    userId: PAYER.id,
    status: "processing",
    amountStars: 50,
    externalPaymentId: "charge-1",
  });
});


/**
 * The sweep issues ONE query per status tier (see SWEEP_STALE_BUDGET), so the
 * mock has to answer by `where.status` rather than hand the same fixture to
 * both — otherwise every fixture row is counted twice.
 */
function serveByStatus(rows: Array<{ status: string }>): (args: unknown) => Promise<unknown[]> {
  return async (args: unknown) => {
    const want = (args as { where?: { status?: string } } | undefined)?.where?.status;
    return rows.filter((r) => r.status === want);
  };
}

describe("settlePrimeTimePayment", () => {
  it("writes the durable row BEFORE claiming, then settles and tells the partner", async () => {
    const api = fakeApi();
    db.match.findUnique.mockResolvedValue(matchRow());
    db.match.updateMany.mockResolvedValue({ count: 1 });

    const res = await settlePrimeTimePayment(api, 100n, "m1", "charge-1");

    expect(res.ok).toBe(true);
    // Order is the invariant: proof money moved exists before anything can throw.
    expect(db.primeTimePurchase.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.match.updateMany.mock.invocationCallOrder[0],
    );
    expect(db.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1", status: "negotiating", primeTimeUnlockedAt: null },
      }),
    );
    expect(db.primeTimePurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "settled" }) }),
    );
    expect(api.refundStarPayment).not.toHaveBeenCalled();
    // The peer, never the buyer — his receipt is the grid redrawing.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]?.[0]).toBe(200);
  });

  it("treats a redelivered charge as an idempotent no-op — no second claim, no refund", async () => {
    const api = fakeApi();
    db.match.findUnique.mockResolvedValue(matchRow());
    db.primeTimePurchase.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const res = await settlePrimeTimePayment(api, 100n, "m1", "charge-1");

    expect(res.ok).toBe(true);
    expect(db.match.updateMany).not.toHaveBeenCalled();
    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });

  it("refunds when the claim buys nothing (both sides paid at once)", async () => {
    const api = fakeApi();
    db.match.findUnique.mockResolvedValue(matchRow());
    db.match.updateMany.mockResolvedValue({ count: 0 });

    const res = await settlePrimeTimePayment(api, 100n, "m1", "charge-1");

    expect(res).toMatchObject({ ok: false, reason: "already-unlocked" });
    expect(api.refundStarPayment).toHaveBeenCalledWith(100, "charge-1");
    expect(db.primeTimePurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_race" }),
      }),
    );
  });

  it("never writes a purchase row for a payer who is not on the match", async () => {
    const api = fakeApi();
    db.match.findUnique.mockResolvedValue(matchRow());

    const res = await settlePrimeTimePayment(api, 999n, "m1", "charge-1");

    expect(res).toMatchObject({ ok: false, reason: "not-participant" });
    expect(db.primeTimePurchase.create).not.toHaveBeenCalled();
  });
});

function purchaseRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    userId: PAYER.id,
    status: "settled",
    amountStars: 50,
    externalPaymentId: "charge-1",
    user: { telegramId: 100n, language: "ru" },
    ...over,
  };
}

describe("refundPrimeTimeForDeadMatch", () => {
  it("returns the Stars and says so, once per settled purchase", async () => {
    const api = fakeApi();
    db.primeTimePurchase.findMany.mockImplementation(serveByStatus([purchaseRow()]));

    const refunded = await refundPrimeTimeForDeadMatch("m1", api);

    expect(refunded).toBe(1);
    expect(api.refundStarPayment).toHaveBeenCalledWith(100, "charge-1");
    expect(db.primeTimePurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_match_died" }),
      }),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a band opened by a subscription — there is no row to return", async () => {
    const api = fakeApi();
    db.primeTimePurchase.findMany.mockImplementation(serveByStatus([]));

    expect(await refundPrimeTimeForDeadMatch("m1", api)).toBe(0);
    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });

  it("does NOT tell the user the money is back when Telegram refused", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("BALANCE_TOO_LOW"));
    db.primeTimePurchase.findMany.mockImplementation(serveByStatus([purchaseRow()]));

    expect(await refundPrimeTimeForDeadMatch("m1", api)).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(db.primeTimePurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refund_failed" }),
      }),
    );
  });

  it("leaves the row for the sweep rather than dropping it when the bot has not booted", async () => {
    mainBotApi.current = null;
    expect(await refundPrimeTimeForDeadMatch("m1")).toBe(0);
    expect(db.primeTimePurchase.findMany).not.toHaveBeenCalled();
  });
});

describe("sweepPrimeTimeRefunds", () => {
  it("retries refund_failed and returns an abandoned processing row as stale", async () => {
    const api = fakeApi();
    db.primeTimePurchase.findMany.mockImplementation(serveByStatus([
      purchaseRow({ status: "refund_failed" }),
      purchaseRow({ id: "p2", status: "processing", externalPaymentId: "charge-2" }),
    ]));

    const res = await sweepPrimeTimeRefunds(api);

    expect(res).toMatchObject({ scanned: 2, refunded: 2, stillFailing: 0 });
    const statuses = db.primeTimePurchase.update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status,
    );
    // Stale first: a `processing` row is a charge taken and never resolved, so
    // it outranks a retry of one that has already failed at least once.
    expect(statuses).toEqual(["refunded_stale", "refunded_race"]);
  });

  it("counts a still-failing refund instead of announcing it", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("nope"));
    db.primeTimePurchase.findMany.mockImplementation(serveByStatus([purchaseRow({ status: "refund_failed" })]));

    const res = await sweepPrimeTimeRefunds(api);

    expect(res).toMatchObject({ refunded: 0, stillFailing: 1 });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("skips a mobile-only payer — a synthetic negative id holds no Stars charge", async () => {
    const api = fakeApi();
    db.primeTimePurchase.findMany.mockImplementation(serveByStatus([
      purchaseRow({
        // A status the SWEEP actually queries — the fixture's default
        // (`settled`) belongs to the dead-match rail, not to this one.
        status: "refund_failed",
        user: { telegramId: -778000001n, language: "en" },
      }),
    ]));

    const res = await sweepPrimeTimeRefunds(api);

    // Counted as skipped rather than dropped: `refunded=0 stillFailing=0` alone
    // reads as "nothing was wrong" when nothing was attempted.
    expect(res).toMatchObject({ scanned: 1, refunded: 0, stillFailing: 0, skipped: 1 });
    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });
});
