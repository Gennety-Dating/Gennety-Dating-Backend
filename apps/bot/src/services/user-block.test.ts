import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn() },
    userBlock: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("./cancel-in-flight-matches.js", () => ({
  claimMatchCancellation: vi.fn(),
  deliverCancelledPartnerEffects: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import {
  claimMatchCancellation,
  deliverCancelledPartnerEffects,
} from "./cancel-in-flight-matches.js";
import {
  blockMatchPartner,
  isPairBlocked,
  listBlockedUsers,
  loadBlockedPairKeys,
  unblockUser,
} from "./user-block.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn };
const mBlock = prisma.userBlock as unknown as {
  upsert: MockFn;
  deleteMany: MockFn;
  findMany: MockFn;
  findFirst: MockFn;
};
const mTx = prisma.$transaction as unknown as MockFn;
const mClaim = claimMatchCancellation as unknown as MockFn;
const mDeliver = deliverCancelledPartnerEffects as unknown as MockFn;

const BLOCKER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARTNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MATCH = "dddddddd-dddd-dddd-dddd-dddddddddddd";

/** Run the callback against the same mocked client the module uses. */
function runTransaction() {
  mTx.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
}

beforeEach(() => {
  vi.clearAllMocks();
  runTransaction();
  mBlock.upsert.mockResolvedValue({ id: "block-1" });
  mClaim.mockResolvedValue(null);
});

describe("blockMatchPartner", () => {
  it("records the block against the other participant", async () => {
    mMatch.findUnique.mockResolvedValue({ userAId: BLOCKER, userBId: PARTNER });

    const result = await blockMatchPartner(MATCH, BLOCKER, null);

    expect(result).toEqual({
      outcome: "ok",
      blockedUserId: PARTNER,
      dateCancelled: false,
    });
    expect(mBlock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId_blockedId: { blockerId: BLOCKER, blockedId: PARTNER } },
        create: { blockerId: BLOCKER, blockedId: PARTNER, matchId: MATCH },
        update: {},
      }),
    );
  });

  it("works from either side of the match", async () => {
    mMatch.findUnique.mockResolvedValue({ userAId: PARTNER, userBId: BLOCKER });

    const result = await blockMatchPartner(MATCH, BLOCKER, null);

    expect(result).toMatchObject({ outcome: "ok", blockedUserId: PARTNER });
  });

  it("cancels a live date and reports it, so the client can say so", async () => {
    mMatch.findUnique.mockResolvedValue({ userAId: BLOCKER, userBId: PARTNER });
    const cancelled = {
      matchId: MATCH,
      partnerUserId: PARTNER,
      partnerTelegramId: 42n,
      partnerLanguage: "en",
      partnerPlatform: "mobile",
      ticketRefunds: [],
    };
    mClaim.mockResolvedValue(cancelled);

    const result = await blockMatchPartner(MATCH, BLOCKER, null);

    expect(result).toMatchObject({ dateCancelled: true });
    // The safety-critical half: the cancellation claim runs inside the same
    // transaction as the block row.
    expect(mClaim).toHaveBeenCalledWith(MATCH, BLOCKER, prisma, { strict: true });
    // Refunds and the partner notice are post-commit compensation.
    expect(mDeliver).toHaveBeenCalledWith([cancelled], null);
  });

  it("skips partner effects entirely when nothing was cancelled", async () => {
    mMatch.findUnique.mockResolvedValue({ userAId: BLOCKER, userBId: PARTNER });

    await blockMatchPartner(MATCH, BLOCKER, null);

    expect(mDeliver).not.toHaveBeenCalled();
  });

  it("refuses a match the caller is not on, without cancelling anything", async () => {
    mMatch.findUnique.mockResolvedValue({ userAId: PARTNER, userBId: STRANGER });

    const result = await blockMatchPartner(MATCH, BLOCKER, null);

    expect(result).toEqual({ outcome: "forbidden" });
    expect(mBlock.upsert).not.toHaveBeenCalled();
    expect(mClaim).not.toHaveBeenCalled();
  });

  it("refuses an unknown match id", async () => {
    mMatch.findUnique.mockResolvedValue(null);

    expect(await blockMatchPartner(MATCH, BLOCKER, null)).toEqual({
      outcome: "forbidden",
    });
  });

  it("is idempotent — a repeat block upserts rather than erroring", async () => {
    mMatch.findUnique.mockResolvedValue({ userAId: BLOCKER, userBId: PARTNER });

    await blockMatchPartner(MATCH, BLOCKER, null);
    await blockMatchPartner(MATCH, BLOCKER, null);

    expect(mBlock.upsert).toHaveBeenCalledTimes(2);
    expect(mBlock.upsert.mock.calls.every(([arg]) => arg.update)).toBe(true);
  });
});

describe("unblockUser", () => {
  it("reports whether anything was actually lifted", async () => {
    mBlock.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await unblockUser(BLOCKER, PARTNER)).toBe(true);

    mBlock.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await unblockUser(BLOCKER, PARTNER)).toBe(false);
  });

  it("only ever deletes the caller's own direction", async () => {
    mBlock.deleteMany.mockResolvedValue({ count: 1 });
    await unblockUser(BLOCKER, PARTNER);
    expect(mBlock.deleteMany).toHaveBeenCalledWith({
      where: { blockerId: BLOCKER, blockedId: PARTNER },
    });
  });
});

describe("listBlockedUsers", () => {
  it("returns only the caller's own direction, newest first", async () => {
    mBlock.findMany.mockResolvedValue([
      {
        blockedId: PARTNER,
        createdAt: new Date("2026-08-23T04:00:00Z"),
        blocked: { firstName: "Alex" },
      },
    ]);

    expect(await listBlockedUsers(BLOCKER)).toEqual([
      {
        userId: PARTNER,
        firstName: "Alex",
        blockedAt: new Date("2026-08-23T04:00:00Z"),
      },
    ]);
    expect(mBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId: BLOCKER },
        orderBy: { createdAt: "desc" },
      }),
    );
  });
});

describe("loadBlockedPairKeys", () => {
  it("emits both directions so one membership test covers either side", async () => {
    mBlock.findMany.mockResolvedValue([
      { blockerId: BLOCKER, blockedId: PARTNER },
    ]);

    const keys = await loadBlockedPairKeys([BLOCKER, PARTNER]);

    expect(keys.has(`${BLOCKER}:${PARTNER}`)).toBe(true);
    expect(keys.has(`${PARTNER}:${BLOCKER}`)).toBe(true);
  });

  it("does not query at all for an empty pool", async () => {
    expect((await loadBlockedPairKeys([])).size).toBe(0);
    expect(mBlock.findMany).not.toHaveBeenCalled();
  });
});

describe("isPairBlocked", () => {
  it("is symmetric", async () => {
    mBlock.findFirst.mockResolvedValue({ id: "block-1" });
    expect(await isPairBlocked(BLOCKER, PARTNER)).toBe(true);

    const where = mBlock.findFirst.mock.calls[0]![0].where;
    expect(where.OR).toEqual([
      { blockerId: BLOCKER, blockedId: PARTNER },
      { blockerId: PARTNER, blockedId: BLOCKER },
    ]);
  });

  it("is false when neither side blocked the other", async () => {
    mBlock.findFirst.mockResolvedValue(null);
    expect(await isPairBlocked(BLOCKER, PARTNER)).toBe(false);
  });
});
