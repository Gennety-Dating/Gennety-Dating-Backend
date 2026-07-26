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

describe("sweepVenueChangeRefunds", () => {
  it("retries a refund_failed row and DMs the user once it actually lands", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockResolvedValue([row()]);

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
    mPurchase.findMany.mockResolvedValue([row({ status: "processing" })]);

    await sweepVenueChangeRefunds(api);

    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_stale" }),
      }),
    );
  });

  it("only looks at processing rows older than the stale window", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockResolvedValue([]);
    const now = new Date("2026-08-01T12:00:00Z");

    await sweepVenueChangeRefunds(api, now);

    const where = mPurchase.findMany.mock.calls[0][0].where as {
      OR: Array<{ status: string; createdAt?: { lt: Date } }>;
    };
    const processingClause = where.OR.find((c) => c.status === "processing")!;
    expect(processingClause.createdAt!.lt).toEqual(
      new Date(now.getTime() - VENUE_PROCESSING_STALE_MS),
    );
  });

  it("keeps a still-failing refund in refund_failed and sends no DM", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("still down"));
    mPurchase.findMany.mockResolvedValue([row()]);

    const res = await sweepVenueChangeRefunds(api);

    expect(res).toMatchObject({ refunded: 0, stillFailing: 1 });
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refund_failed" }),
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("skips a mobile-only user (synthetic negative telegramId holds no Stars charge)", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockResolvedValue([
      row({ user: { telegramId: -42n, language: "en" } }),
    ]);

    const res = await sweepVenueChangeRefunds(api);

    expect(api.refundStarPayment).not.toHaveBeenCalled();
    expect(res).toMatchObject({ scanned: 1, refunded: 0, stillFailing: 0 });
  });
});
