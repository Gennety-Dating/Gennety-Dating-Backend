import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

const refundAndFallbackToScheduling = vi.fn();
const retryPendingStarsGateRefunds = vi.fn();
const settleStrandedTicketRefund = vi.fn();
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  refundAndFallbackToScheduling: (...a: unknown[]) => refundAndFallbackToScheduling(...a),
  retryPendingStarsGateRefunds: (...a: unknown[]) => retryPendingStarsGateRefunds(...a),
  settleStrandedTicketRefund: (...a: unknown[]) => settleStrandedTicketRefund(...a),
}));

import { prisma } from "@gennety/db";
import { ticketExpiryTick } from "./ticket-expiry.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFindMany = (prisma.match as unknown as { findMany: MockFn }).findMany;
const fakeApi = {} as Parameters<typeof ticketExpiryTick>[0];

beforeEach(() => {
  mFindMany.mockReset();
  // The tick makes more than one query now; a database answers every one of
  // them, so the default is an empty page rather than `undefined`.
  mFindMany.mockResolvedValue([]);
  refundAndFallbackToScheduling.mockReset();
  retryPendingStarsGateRefunds.mockReset();
  retryPendingStarsGateRefunds.mockResolvedValue(0);
  settleStrandedTicketRefund.mockReset();
  settleStrandedTicketRefund.mockResolvedValue(false);
});

describe("ticketExpiryTick", () => {
  it("settles a refund stranded by a match that stopped being live", async () => {
    // The stale query is scoped to `status: "negotiating"` and the cancellation
    // rail skips `refund_pending` on purpose, so a match that left `negotiating`
    // between claiming the refund and crediting it fell through both rails and
    // sat in `refund_pending` forever — the ticket simply gone.
    mFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "dead" }]);
    settleStrandedTicketRefund.mockResolvedValue(true);

    const res = await ticketExpiryTick(fakeApi);

    expect(settleStrandedTicketRefund).toHaveBeenCalledWith(fakeApi, "dead");
    expect(res.swept).toBe(1);
    // And it asks for exactly the rows the live sweep cannot see.
    expect(mFindMany.mock.calls[1]![0].where).toMatchObject({
      status: { not: "negotiating" },
      ticketStatus: "refund_pending",
    });
  });

  it("does not count a stranded refund that failed to settle", async () => {
    // Still owed. The row stays `refund_pending` so the next tick retries,
    // rather than a debt being reported as paid.
    mFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "dead" }]);
    settleStrandedTicketRefund.mockResolvedValue(false);

    const res = await ticketExpiryTick(fakeApi);

    expect(res.swept).toBe(0);
  });

  it("sweeps each stale ticket gate via the refund/fallback path", async () => {
    mFindMany.mockResolvedValueOnce([{ id: "m1" }, { id: "m2" }]);
    refundAndFallbackToScheduling.mockResolvedValue(undefined);

    const res = await ticketExpiryTick(fakeApi);

    expect(res.swept).toBe(2);
    expect(retryPendingStarsGateRefunds).toHaveBeenCalledWith(fakeApi);
    expect(refundAndFallbackToScheduling).toHaveBeenCalledTimes(2);
    expect(refundAndFallbackToScheduling).toHaveBeenCalledWith(fakeApi, "m1");
    expect(refundAndFallbackToScheduling).toHaveBeenCalledWith(fakeApi, "m2");
  });

  it("only queries pending/partial rows whose deadline has lapsed", async () => {
    mFindMany.mockResolvedValueOnce([]);
    await ticketExpiryTick(fakeApi);
    const where = mFindMany.mock.calls[0]![0].where;
    expect(where.status).toBe("negotiating");
    expect(where.OR[0].ticketStatus).toEqual({ in: ["pending", "partial"] });
    expect(where.OR[0].ticketExpiresAt.lt).toBeInstanceOf(Date);
    expect(where.OR[1]).toEqual({ ticketStatus: "refund_pending" });
  });

  it("keeps sweeping after one match throws", async () => {
    mFindMany.mockResolvedValueOnce([{ id: "bad" }, { id: "ok" }]);
    refundAndFallbackToScheduling
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const res = await ticketExpiryTick(fakeApi);

    expect(res.swept).toBe(1); // only the successful one counts
    expect(refundAndFallbackToScheduling).toHaveBeenCalledTimes(2);
  });
});
