import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { prisma } from "@gennety/db";
import { expireStaleMatches, MATCH_TTL_MS } from "./match-expiry.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatchUpdateMany = (prisma.match as unknown as { updateMany: MockFn }).updateMany;

describe("expireStaleMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls updateMany with correct filters for 24h TTL", async () => {
    mMatchUpdateMany.mockResolvedValueOnce({ count: 3 });

    const result = await expireStaleMatches();

    expect(result.expired).toBe(3);
    expect(mMatchUpdateMany).toHaveBeenCalledTimes(1);

    const arg = mMatchUpdateMany.mock.calls[0]![0] as {
      where: { status: string; dispatchedAt: { not: null; lt: Date } };
      data: { status: string };
    };
    expect(arg.where.status).toBe("proposed");
    expect(arg.where.dispatchedAt.not).toBeNull();
    expect(arg.where.dispatchedAt.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe("expired");

    // The cutoff should be approximately 24h ago.
    const expectedCutoff = Date.now() - MATCH_TTL_MS;
    const actualCutoff = arg.where.dispatchedAt.lt.getTime();
    expect(Math.abs(actualCutoff - expectedCutoff)).toBeLessThan(1000);
  });

  it("accepts custom TTL", async () => {
    mMatchUpdateMany.mockResolvedValueOnce({ count: 1 });
    const customTtl = 60 * 60 * 1000; // 1 hour

    await expireStaleMatches(customTtl);

    const arg = mMatchUpdateMany.mock.calls[0]![0] as {
      where: { dispatchedAt: { lt: Date } };
    };
    const expectedCutoff = Date.now() - customTtl;
    const actualCutoff = arg.where.dispatchedAt.lt.getTime();
    expect(Math.abs(actualCutoff - expectedCutoff)).toBeLessThan(1000);
  });

  it("returns 0 when no matches expired", async () => {
    mMatchUpdateMany.mockResolvedValueOnce({ count: 0 });
    const result = await expireStaleMatches();
    expect(result.expired).toBe(0);
  });
});
