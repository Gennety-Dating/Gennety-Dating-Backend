import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRawUnsafe: vi.fn(),
    match: { findFirst: vi.fn(), create: vi.fn() },
    profile: { updateMany: vi.fn() },
    matchScoreLog: { create: vi.fn() },
  };
  return {
    userFindMany: vi.fn(),
    matchFindFirst: vi.fn(),
    queryRawUnsafe: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    tx,
  };
});

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
    match: { findFirst: mocks.matchFindFirst },
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $transaction: mocks.transaction,
  },
}));

import {
  buildCandidateSql,
  createProposedMatch,
  loadEligibleUsers,
} from "./match-engine.js";
import { ACTIVE_MATCH_STATUSES } from "./active-match-priority.js";

describe("match allocation active-slot guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.tx.$queryRawUnsafe.mockResolvedValue([]);
    mocks.tx.match.findFirst.mockResolvedValue(null);
    mocks.tx.match.create.mockResolvedValue({ id: "match-new" });
    mocks.tx.profile.updateMany.mockResolvedValue({ count: 2 });
  });

  it("excludes users who participate in any live match from both eligibility scans", async () => {
    await loadEligibleUsers();

    expect(mocks.userFindMany).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.userFindMany.mock.calls) {
      expect(args.where.matchesAsA).toEqual({
        none: { status: { in: [...ACTIVE_MATCH_STATUSES] } },
      });
      expect(args.where.matchesAsB).toEqual({
        none: { status: { in: [...ACTIVE_MATCH_STATUSES] } },
      });
      expect(args.where.profile.embeddingDirty).toBe(false);
    }
  });

  it("locks both participants and refuses creation when either gained an active match", async () => {
    mocks.tx.match.findFirst.mockResolvedValueOnce({ id: "already-active" });

    await expect(createProposedMatch("bbbb", "aaaa")).resolves.toBeNull();

    expect(mocks.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      ["aaaa", "bbbb"],
    );
    expect(mocks.tx.match.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            status: { in: [...ACTIVE_MATCH_STATUSES] },
            OR: [
              { userAId: { in: ["aaaa", "bbbb"] } },
              { userBId: { in: ["aaaa", "bbbb"] } },
            ],
          },
          { userAId: "bbbb", userBId: "aaaa" },
          { userAId: "aaaa", userBId: "bbbb" },
        ],
      },
      select: { id: true },
    });
    expect(mocks.tx.match.create).not.toHaveBeenCalled();
  });

  it("creates the proposal only after the locked active-match re-check passes", async () => {
    await expect(createProposedMatch("aaaa", "bbbb")).resolves.toEqual({ id: "match-new" });

    expect(mocks.tx.match.create).toHaveBeenCalledWith({
      data: { userAId: "aaaa", userBId: "bbbb", status: "proposed" },
      select: { id: true },
    });
  });

  it("also excludes active candidates in the single-seeker SQL path", () => {
    const sql = buildCandidateSql();
    expect(sql).toContain("active_match.status IN ('proposed', 'negotiating', 'negotiating_venue', 'scheduled')");
    expect(sql).toContain("active_match.user_a_id = u.id OR active_match.user_b_id = u.id");
    expect(sql).toContain("p.embedding_dirty = false");
  });
});
