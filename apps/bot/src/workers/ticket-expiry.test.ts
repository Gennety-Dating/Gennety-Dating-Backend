import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

const refundAndFallbackToScheduling = vi.fn();
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  refundAndFallbackToScheduling: (...a: unknown[]) => refundAndFallbackToScheduling(...a),
}));

import { prisma } from "@gennety/db";
import { ticketExpiryTick } from "./ticket-expiry.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFindMany = (prisma.match as unknown as { findMany: MockFn }).findMany;
const fakeApi = {} as Parameters<typeof ticketExpiryTick>[0];

beforeEach(() => {
  mFindMany.mockReset();
  refundAndFallbackToScheduling.mockReset();
});

describe("ticketExpiryTick", () => {
  it("sweeps each stale ticket gate via the refund/fallback path", async () => {
    mFindMany.mockResolvedValueOnce([{ id: "m1" }, { id: "m2" }]);
    refundAndFallbackToScheduling.mockResolvedValue(undefined);

    const res = await ticketExpiryTick(fakeApi);

    expect(res.swept).toBe(2);
    expect(refundAndFallbackToScheduling).toHaveBeenCalledTimes(2);
    expect(refundAndFallbackToScheduling).toHaveBeenCalledWith(fakeApi, "m1");
    expect(refundAndFallbackToScheduling).toHaveBeenCalledWith(fakeApi, "m2");
  });

  it("only queries pending/partial rows whose deadline has lapsed", async () => {
    mFindMany.mockResolvedValueOnce([]);
    await ticketExpiryTick(fakeApi);
    const where = mFindMany.mock.calls[0]![0].where;
    expect(where.status).toBe("negotiating");
    expect(where.ticketStatus).toEqual({ in: ["pending", "partial"] });
    expect(where.ticketExpiresAt.lt).toBeInstanceOf(Date);
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
