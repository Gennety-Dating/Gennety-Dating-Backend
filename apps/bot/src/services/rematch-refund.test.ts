/**
 * The Rematch refund rail (REMATCH_PRODUCT_SPEC.md, D1).
 *
 * This file did not exist until the 2026-08-27 audit, which is worth stating:
 * its two siblings (`venue-change-refund`, `prime-time-purchase`) were covered
 * and this one — the rail that returns real money on the product's only paid
 * on-demand feature — was not. The head-of-line fix below was written into all
 * three at once and could only be proven red on the other two.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    rematchPurchase: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("./founder-notify.js", () => ({
  notifyFounderPurchaseRefunded: vi.fn(),
}));

import { prisma } from "@gennety/db";
import {
  REMATCH_PROCESSING_STALE_MS,
  refundRematchPurchase,
  refundStatusForReason,
  sweepRematchRefunds,
} from "./rematch-refund.js";

type MockFn = ReturnType<typeof vi.fn>;
const mPurchase = (prisma as unknown as {
  rematchPurchase: { findMany: MockFn; update: MockFn };
}).rematchPurchase;

function fakeApi() {
  return {
    refundStarPayment: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as Parameters<typeof sweepRematchRefunds>[0] & {
    refundStarPayment: MockFn;
    sendMessage: MockFn;
  };
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rp1",
    status: "refund_failed",
    externalPaymentId: "charge-1",
    userId: "u1",
    amountStars: 150,
    user: { telegramId: 300n, language: "en" },
    ...over,
  };
}

/**
 * The sweep issues ONE query per status tier, so the mock has to answer by
 * `where.status` rather than hand the same fixture to both — otherwise every
 * fixture row is counted twice.
 */
function serveByStatus(rows: Array<{ status: string }>): (args: unknown) => Promise<unknown[]> {
  return async (args: unknown) => {
    const want = (args as { where?: { status?: string } } | undefined)?.where?.status;
    return rows.filter((r) => r.status === want);
  };
}

beforeEach(() => {
  mPurchase.findMany.mockReset();
  mPurchase.update.mockReset();
  mPurchase.update.mockResolvedValue({
    userId: "u1",
    amountStars: 150,
    externalPaymentId: "charge-1",
  });
});

describe("refundStatusForReason", () => {
  it("says WHY the money came back, not just that it did", () => {
    // The two say opposite things about the city's pool, and the founder feed
    // reads them that way: `no_candidate` means we looked and it was thin,
    // `ineligible` means we never looked. Collapsing them would lose the only
    // signal that says whether a market is running out of people.
    expect(refundStatusForReason("no_candidate")).toBe("refunded_no_candidate");
    expect(refundStatusForReason("create_failed")).toBe("refunded_no_candidate");

    for (const reason of [
      "feature_off",
      "not_found",
      "not_male",
      "not_matchable",
      "live_match",
      "weekly_limit",
      "cooldown",
      "pre_batch_blackout",
    ] as const) {
      expect(refundStatusForReason(reason), reason).toBe("refunded_ineligible");
    }

    // A refusal that names no reason falls to `ineligible`, never to
    // `no_candidate` — the conservative direction, because the empty-pool
    // status is the one anybody reads as a fact about the market.
    expect(refundStatusForReason(undefined)).toBe("refunded_ineligible");
  });
});

describe("refundRematchPurchase", () => {
  it("only reports success when the provider actually returned the Stars", async () => {
    const api = fakeApi();

    const ok = await refundRematchPurchase(
      api,
      { id: "rp1", externalPaymentId: "charge-1", status: "processing" },
      300n,
      "refunded_ineligible",
    );

    expect(ok).toBe(true);
    expect(api.refundStarPayment).toHaveBeenCalledWith(300, "charge-1");
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "refunded_ineligible",
          refundError: null,
        }),
      }),
    );
  });

  // The rail's one rule: never record or announce a refund that did not happen.
  it("parks a failed refund in refund_failed and reports false", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("charge not refundable"));

    const ok = await refundRematchPurchase(
      api,
      { id: "rp1", externalPaymentId: "charge-1", status: "processing" },
      300n,
      "refunded_ineligible",
    );

    expect(ok).toBe(false);
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refund_failed" }),
      }),
    );
  });

  // Half of the head-of-line fix: without a "last attempted" stamp the retry
  // tier has nothing to rotate on and re-tries one stuck row forever.
  it("stamps resolvedAt on a FAILED attempt, not only on a terminal one", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("nope"));

    await refundRematchPurchase(
      api,
      { id: "rp1", externalPaymentId: "charge-1", status: "processing" },
      300n,
      "refunded_ineligible",
    );

    const data = (mPurchase.update.mock.calls[0]![0] as { data: { resolvedAt?: Date } }).data;
    expect(data.resolvedAt).toBeInstanceOf(Date);
  });
});

describe("sweepRematchRefunds", () => {
  it("refunds a refund_failed row and DMs the buyer once it lands", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([row()]));

    const res = await sweepRematchRefunds(api);

    expect(api.refundStarPayment).toHaveBeenCalledWith(300, "charge-1");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ scanned: 1, refunded: 1, stillFailing: 0 });
  });

  it("settles an abandoned processing row as refunded_ineligible", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(
      serveByStatus([row({ id: "rp2", status: "processing" })]),
    );

    await sweepRematchRefunds(api);

    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_ineligible" }),
      }),
    );
  });

  it("sends no DM when the refund did not actually land", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("nope"));
    mPurchase.findMany.mockImplementation(serveByStatus([row()]));

    const res = await sweepRematchRefunds(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(res).toMatchObject({ refunded: 0, stillFailing: 1 });
  });

  it("counts an unreachable payer as skipped rather than dropping it", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(
      serveByStatus([row({ user: { telegramId: -778000001n, language: "en" } })]),
    );

    const res = await sweepRematchRefunds(api);

    expect(api.refundStarPayment).not.toHaveBeenCalled();
    // Without `skipped` this tick logs `refunded=0 stillFailing=0`, which reads
    // as "nothing was wrong" when nothing was attempted.
    expect(res).toMatchObject({ scanned: 1, refunded: 0, stillFailing: 0, skipped: 1 });
  });

  it("only treats processing rows older than the stale window as abandoned", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([]));
    const now = new Date("2026-08-27T12:00:00Z");

    await sweepRematchRefunds(api, now);

    const wheres = mPurchase.findMany.mock.calls.map(
      (c: unknown[]) =>
        (c[0] as { where: { status: string; createdAt?: { lt: Date } } }).where,
    );
    const processing = wheres.find((w) => w.status === "processing")!;
    expect(processing.createdAt!.lt).toEqual(
      new Date(now.getTime() - REMATCH_PROCESSING_STALE_MS),
    );
  });

  // Regression: one `OR` query ordered by `createdAt` and capped at 50 meant a
  // permanently failing row kept its original timestamp and sat in the first
  // page forever — a genuinely refundable purchase behind it was never even
  // fetched. Money kept, silently, on the product's only paid re-run.
  it("reaches a fresh stale row even behind a wall of permanently failing ones", async () => {
    const api = fakeApi();
    const wall = Array.from({ length: 60 }, (_, i) =>
      row({ id: `stuck-${i}`, externalPaymentId: `stuck-charge-${i}` }),
    );
    const owed = row({
      id: "owed",
      status: "processing",
      externalPaymentId: "owed-charge",
    });
    mPurchase.findMany.mockImplementation(serveByStatus([...wall, owed]));

    await sweepRematchRefunds(api);

    expect(api.refundStarPayment).toHaveBeenCalledWith(300, "owed-charge");
  });

  it("orders retries by least-recently-attempted, nulls first", async () => {
    const api = fakeApi();
    mPurchase.findMany.mockImplementation(serveByStatus([]));

    await sweepRematchRefunds(api);

    const retry = mPurchase.findMany.mock.calls
      .map((c: unknown[]) => c[0] as { where: { status: string }; orderBy: unknown })
      .find((a) => a.where.status === "refund_failed");
    expect(retry!.orderBy).toEqual({ resolvedAt: { sort: "asc", nulls: "first" } });
  });
});
