import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The demo puppet is exempt from the single-live-match invariant — and only it,
 * and only in demo mode (DEMO_MODE.md).
 *
 * This is the one demo branch inside the allocator that also runs the real
 * Thursday drop and the paid Rematch, so both halves are pinned here: that the
 * exemption reaches BOTH places that enforce the invariant, and that the
 * visitor on the other side of the same pair keeps being held to it.
 *
 * The production shape (no exemption, `where` rebuilt byte-for-byte) is pinned
 * by `match-engine-eligibility.test.ts`, which must stay green alongside this.
 */

const VISITOR = "aaaa";
const PUPPET = "bbbb";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRawUnsafe: vi.fn(),
    user: { findMany: vi.fn() },
    match: { findFirst: vi.fn(), create: vi.fn() },
    profile: { updateMany: vi.fn() },
    matchScoreLog: { create: vi.fn() },
  };
  return {
    demoEnabled: { value: true },
    puppetIdsAmong: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    tx,
  };
});

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findMany: vi.fn() },
    match: { findFirst: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $transaction: mocks.transaction,
  },
}));

vi.mock("../demo/config.js", () => ({
  get DEMO_MODE_ENABLED() {
    return mocks.demoEnabled.value;
  },
}));

vi.mock("../demo/partners.js", () => ({
  demoPuppetIdsAmong: mocks.puppetIdsAmong,
}));

import { createProposedMatch } from "./match-engine.js";
import { ACTIVE_MATCH_STATUSES } from "./active-match-priority.js";

const liveMatchFree = {
  matchesAsA: { none: { status: { in: [...ACTIVE_MATCH_STATUSES] } } },
  matchesAsB: { none: { status: { in: [...ACTIVE_MATCH_STATUSES] } } },
};

describe("demo puppet is exempt from the single-live-match invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.demoEnabled.value = true;
    mocks.puppetIdsAmong.mockResolvedValue([PUPPET]);

    const eligibleRows = [VISITOR, PUPPET].map((id) => ({
      id,
      age: 25,
      gender: "male",
      major: null,
      preference: "women",
      universityDomain: null,
      profile: {
        height: null,
        negativeConstraints: null,
        psychologicalSummary: null,
        energyAxis: null,
        orientationAxis: null,
        eloScore: 500,
        standbyCount: 0,
        homeCityKey: "ua:kyiv",
        ageRangeMin: null,
        ageRangeMax: null,
      },
    }));
    mocks.tx.user.findMany.mockResolvedValue(eligibleRows);
    mocks.tx.$queryRawUnsafe.mockImplementation((sql: string) =>
      sql.includes("embedding::text")
        ? Promise.resolve(eligibleRows.map(({ id }) => ({ user_id: id, embedding: "[0]" })))
        : Promise.resolve([]),
    );
    mocks.tx.match.findFirst.mockResolvedValue(null);
    mocks.tx.match.create.mockResolvedValue({ id: "match-new" });
    mocks.tx.profile.updateMany.mockResolvedValue({ count: 2 });
  });

  it("keeps the puppet eligible in BOTH eligibility scans while it holds a live match", async () => {
    await createProposedMatch(VISITOR, PUPPET);

    // Two scans: the cooldown one and the never-matched one. A fix applied to
    // only one of them leaves the demo broken for half the puppet's lifecycle.
    expect(mocks.tx.user.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.tx.user.findMany.mock.calls) {
      expect(args.where.OR).toEqual([{ id: { in: [PUPPET] } }, liveMatchFree]);
      expect(args.where.matchesAsA).toBeUndefined();
      expect(args.where.matchesAsB).toBeUndefined();
    }
  });

  it("leaves the visitor's own live match a hard conflict", async () => {
    await createProposedMatch(VISITOR, PUPPET);

    const [[args]] = mocks.tx.match.findFirst.mock.calls;
    expect(args.where.OR[0]).toEqual({
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: { in: [VISITOR] } }, { userBId: { in: [VISITOR] } }],
    });
  });

  it("still refuses when the VISITOR holds a live match", async () => {
    mocks.tx.match.findFirst.mockResolvedValueOnce({ id: "visitor-already-busy" });

    await expect(createProposedMatch(VISITOR, PUPPET)).resolves.toBeNull();
    expect(mocks.tx.match.create).not.toHaveBeenCalled();
  });

  it("keeps the lifetime pair ban — the same visitor never sees the same puppet twice", async () => {
    await createProposedMatch(VISITOR, PUPPET);

    const [[args]] = mocks.tx.match.findFirst.mock.calls;
    expect(args.where.OR).toContainEqual({ userAId: VISITOR, userBId: PUPPET });
    expect(args.where.OR).toContainEqual({ userAId: PUPPET, userBId: VISITOR });
  });

  it("does not even ask who is a puppet outside demo mode", async () => {
    mocks.demoEnabled.value = false;

    await createProposedMatch(VISITOR, PUPPET);

    expect(mocks.puppetIdsAmong).not.toHaveBeenCalled();
    for (const [args] of mocks.tx.user.findMany.mock.calls) {
      expect(args.where.matchesAsA).toEqual(liveMatchFree.matchesAsA);
      expect(args.where.OR).toBeUndefined();
    }
    const [[args]] = mocks.tx.match.findFirst.mock.calls;
    expect(args.where.OR[0].OR).toEqual([
      { userAId: { in: [VISITOR, PUPPET] } },
      { userBId: { in: [VISITOR, PUPPET] } },
    ]);
  });
});
