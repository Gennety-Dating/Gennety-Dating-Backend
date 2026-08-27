import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    venueChangePurchase: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import {
  sweepVenueChangeRefunds,
  VENUE_PROCESSING_STALE_MS,
} from "./venue-change-refund.js";

type MockFn = ReturnType<typeof vi.fn>;
const mPurchase = (prisma as unknown as {
  venueChangePurchase: { findMany: MockFn; update: MockFn };
}).venueChangePurchase;

function fakeApi() {
  return {
    refundStarPayment: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as Parameters<typeof sweepVenueChangeRefunds>[0] & {
    refundStarPayment: MockFn;
    sendMessage: MockFn;
  };
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "vp1",
    status: "refund_failed",
    externalPaymentId: "charge-1",
    user: { telegramId: 200n, language: "en" },
    ...over,
  };
}

beforeEach(() => {
  mPurchase.findMany.mockReset();
  mPurchase.update.mockReset();
  mPurchase.update.mockResolvedValue({});
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

describe("sweepVenueChangeRefunds", () => {
  it("retries a refund_failed row and DMs the user once it actually lands", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([row()]));

    const res = await sweepVenueChangeRefunds(api);

    expect(api.refundStarPayment).toHaveBeenCalledWith(200, "charge-1");
    expect(res).toMatchObject({ scanned: 1, refunded: 1, stillFailing: 0 });
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_race", refundError: null }),
      }),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refunds a processing row abandoned mid-settle as refunded_stale", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([row({ status: "processing" })]));

    await sweepVenueChangeRefunds(api);

    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_stale" }),
      }),
    );
  });

  it("only looks at processing rows older than the stale window", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([]));
    const now = new Date("2026-08-01T12:00:00Z");

    await sweepVenueChangeRefunds(api, now);

    // The sweep queries each status tier separately, so find the one that asks
    // for `processing` rather than assuming a position — the point of the
    // assertion is the stale cutoff, not the query's shape.
    const wheres = mPurchase.findMany.mock.calls.map(
      (c: unknown[]) =>
        (c[0] as { where: { status: string; createdAt?: { lt: Date } } }).where,
    );
    const processing = wheres.find((w) => w.status === "processing")!;
    expect(processing.createdAt!.lt).toEqual(
      new Date(now.getTime() - VENUE_PROCESSING_STALE_MS),
    );
  });

  it("keeps a still-failing refund in refund_failed and sends no DM", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("still down"));
    mPurchase.findMany.mockImplementation(serveByStatus([row()]));

    const res = await sweepVenueChangeRefunds(api);

    expect(res).toMatchObject({ refunded: 0, stillFailing: 1 });
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refund_failed" }),
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  // Regression: the sweep used to be ONE `OR` query ordered by `createdAt`,
  // capped at 50. A row that fails permanently (a deleted account, a charge
  // Telegram will not reverse) keeps its original `createdAt`, so it stayed
  // inside the first page forever — fifty of them and a genuinely refundable
  // purchase behind them was never even fetched. Money kept, silently.
  it("reaches a fresh stale row even behind a wall of permanently failing ones", async () => {
    const api = fakeApi();
    const wall = Array.from({ length: 60 }, (_, i) =>
      row({ id: `stuck-${i}`, externalPaymentId: `stuck-charge-${i}` }),
    );
    const fresh = row({
      id: "owed",
      status: "processing",
      externalPaymentId: "owed-charge",
    });
    mPurchase.findMany.mockImplementation(serveByStatus([...wall, fresh]));

    await sweepVenueChangeRefunds(api);

    expect(api.refundStarPayment).toHaveBeenCalledWith(200, "owed-charge");
  });

  // The other half of the same fix: the retry tier is ordered by "least
  // recently attempted", so a stuck head sinks instead of being re-tried every
  // hour while everything behind it waits.
  it("orders retries by least-recently-attempted, nulls first", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([]));

    await sweepVenueChangeRefunds(api);

    const retryCall = mPurchase.findMany.mock.calls
      .map((c: unknown[]) => c[0] as { where: { status: string }; orderBy: unknown })
      .find((a) => a.where.status === "refund_failed");
    expect(retryCall!.orderBy).toEqual({
      resolvedAt: { sort: "asc", nulls: "first" },
    });
  });

  it("skips a mobile-only user (synthetic negative telegramId holds no Stars charge)", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([
      row({ user: { telegramId: -42n, language: "en" } }),
    ]));

    const res = await sweepVenueChangeRefunds(api);

    expect(api.refundStarPayment).not.toHaveBeenCalled();
    expect(res).toMatchObject({ scanned: 1, refunded: 0, stillFailing: 0 });
  });
});
