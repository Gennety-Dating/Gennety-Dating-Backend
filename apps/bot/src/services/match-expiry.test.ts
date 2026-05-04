import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    profile: {
      update: vi.fn(),
    },
    matchEvent: {
      create: vi.fn().mockResolvedValue(undefined),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
}));

vi.mock("../utils/elo-calculator.js", () => ({
  applySilentIgnorePenalty: vi.fn().mockResolvedValue(490),
}));

import { prisma } from "@gennety/db";
import { applySilentIgnorePenalty } from "../utils/elo-calculator.js";
import { expireStaleMatches, MATCH_TTL_MS } from "./match-expiry.js";

type MockFn = ReturnType<typeof vi.fn>;

const mMatchFindMany = (prisma.match as unknown as { findMany: MockFn }).findMany;
const mMatchUpdateMany = (prisma.match as unknown as { updateMany: MockFn }).updateMany;
const mProfileUpdate = (prisma.profile as unknown as { update: MockFn }).update;
const mEventCreate = (prisma as unknown as { matchEvent: { create: MockFn } }).matchEvent.create;
const mPenalty = applySilentIgnorePenalty as unknown as MockFn;

const sideA = {
  telegramId: 100n,
  language: "en",
};
const sideB = {
  telegramId: 200n,
  language: "ru",
};

function buildCandidate(overrides: Partial<{
  id: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  pitchMessageIdA: number | null;
  pitchMessageIdB: number | null;
}> = {}) {
  return {
    id: overrides.id ?? "match-1",
    userAId: "user-a",
    userBId: "user-b",
    acceptedByA: overrides.acceptedByA ?? null,
    acceptedByB: overrides.acceptedByB ?? null,
    pitchMessageIdA: overrides.pitchMessageIdA ?? 11,
    pitchMessageIdB: overrides.pitchMessageIdB ?? 22,
    userA: sideA,
    userB: sideB,
  };
}

describe("expireStaleMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mMatchUpdateMany.mockResolvedValue({ count: 1 });
    mMatchFindMany.mockResolvedValue([]);
  });

  it("uses the 24h cutoff and the right filter shape", async () => {
    await expireStaleMatches();

    expect(mMatchFindMany).toHaveBeenCalledTimes(1);
    const arg = mMatchFindMany.mock.calls[0]![0] as {
      where: {
        status: string;
        dispatchedAt: { not: null; lt: Date };
        NOT: { AND: Array<{ acceptedByA?: boolean; acceptedByB?: boolean }> };
      };
    };
    expect(arg.where.status).toBe("proposed");
    expect(arg.where.dispatchedAt.lt).toBeInstanceOf(Date);
    const expected = Date.now() - MATCH_TTL_MS;
    expect(Math.abs(arg.where.dispatchedAt.lt.getTime() - expected)).toBeLessThan(1000);
  });

  it("returns no matches when nothing is past TTL", async () => {
    const result = await expireStaleMatches();
    expect(result.expired).toBe(0);
    expect(result.matches).toEqual([]);
    expect(mMatchUpdateMany).not.toHaveBeenCalled();
  });

  it("flips proposed → expired atomically and skips when the row was already moved", async () => {
    mMatchFindMany.mockResolvedValueOnce([buildCandidate({ acceptedByA: true })]);
    mMatchUpdateMany.mockResolvedValueOnce({ count: 0 }); // race: already transitioned

    const result = await expireStaleMatches();

    expect(result.expired).toBe(0);
    expect(result.matches).toEqual([]);
    expect(mProfileUpdate).not.toHaveBeenCalled();
    expect(mEventCreate).not.toHaveBeenCalled();
  });

  it("first-offense silent side: increments counter, NO Elo penalty, classifies as silent", async () => {
    mMatchFindMany.mockResolvedValueOnce([
      buildCandidate({ acceptedByA: null, acceptedByB: false }),
    ]);
    mProfileUpdate.mockResolvedValueOnce({ silentIgnoreCount: 1 });

    const result = await expireStaleMatches();

    expect(result.expired).toBe(1);
    expect(mProfileUpdate).toHaveBeenCalledTimes(1);
    expect(mPenalty).not.toHaveBeenCalled();

    const m = result.matches[0]!;
    const a = m.sides.find((s) => s.side === "A")!;
    const b = m.sides.find((s) => s.side === "B")!;
    expect(a.role).toBe("silent");
    expect(a.offenseCount).toBe(1);
    expect(a.penalised).toBe(false);
    // Notify layer needs to know peer's prior verdict to surface
    // "you missed an accepted date" only when it's actually true.
    expect(a.peerAccepted).toBe(false);
    expect(b.role).toBe("responder");
    expect(b.offenseCount).toBeUndefined();
    expect(b.peerAccepted).toBe(null);
  });

  it("propagates peerAccepted=true so the silent-with-accepted-peer branch fires", async () => {
    mMatchFindMany.mockResolvedValueOnce([
      buildCandidate({ acceptedByA: null, acceptedByB: true }),
    ]);
    mProfileUpdate.mockResolvedValueOnce({ silentIgnoreCount: 1 });

    const result = await expireStaleMatches();

    const a = result.matches[0]!.sides.find((s) => s.side === "A")!;
    expect(a.role).toBe("silent");
    expect(a.peerAccepted).toBe(true);
  });

  it("repeat-offense silent side: increments counter AND applies Elo penalty", async () => {
    mMatchFindMany.mockResolvedValueOnce([
      buildCandidate({ acceptedByA: null, acceptedByB: true }),
    ]);
    mProfileUpdate.mockResolvedValueOnce({ silentIgnoreCount: 2 });

    const result = await expireStaleMatches();

    expect(mPenalty).toHaveBeenCalledTimes(1);
    expect(mPenalty).toHaveBeenCalledWith("user-a");

    const a = result.matches[0]!.sides.find((s) => s.side === "A")!;
    expect(a.role).toBe("silent");
    expect(a.offenseCount).toBe(2);
    expect(a.penalised).toBe(true);
  });

  it("both silent: increments both counters; penalises only the repeat side", async () => {
    mMatchFindMany.mockResolvedValueOnce([
      buildCandidate({ acceptedByA: null, acceptedByB: null }),
    ]);
    // A is first offense, B is repeat.
    mProfileUpdate
      .mockResolvedValueOnce({ silentIgnoreCount: 1 })
      .mockResolvedValueOnce({ silentIgnoreCount: 3 });

    const result = await expireStaleMatches();

    expect(mProfileUpdate).toHaveBeenCalledTimes(2);
    expect(mPenalty).toHaveBeenCalledTimes(1);
    expect(mPenalty).toHaveBeenCalledWith("user-b");

    const a = result.matches[0]!.sides.find((s) => s.side === "A")!;
    const b = result.matches[0]!.sides.find((s) => s.side === "B")!;
    expect(a.role).toBe("silent");
    expect(a.penalised).toBe(false);
    expect(b.role).toBe("silent");
    expect(b.penalised).toBe(true);
  });

  it("writes EXPIRED_SILENT and EXPIRED_PEER_IGNORED audit rows per side", async () => {
    mMatchFindMany.mockResolvedValueOnce([
      buildCandidate({ acceptedByA: null, acceptedByB: true }),
    ]);
    mProfileUpdate.mockResolvedValueOnce({ silentIgnoreCount: 1 });

    await expireStaleMatches();

    const calls = mEventCreate.mock.calls.map((c) => c[0].data);
    const silentRow = calls.find((d) => d.actionType === "EXPIRED_SILENT")!;
    const responderRow = calls.find((d) => d.actionType === "EXPIRED_PEER_IGNORED")!;

    expect(silentRow.actorId).toBe("user-a"); // silent user is the actor
    expect(silentRow.targetId).toBe("user-b");
    expect(responderRow.actorId).toBe("user-a"); // peer (silent) drives the audit
    expect(responderRow.targetId).toBe("user-b");
  });

  it("survives a profile-update failure on one side without blocking the other", async () => {
    mMatchFindMany.mockResolvedValueOnce([
      buildCandidate({ acceptedByA: null, acceptedByB: null }),
    ]);
    mProfileUpdate
      .mockRejectedValueOnce(new Error("transient db error"))
      .mockResolvedValueOnce({ silentIgnoreCount: 1 });

    const result = await expireStaleMatches();

    expect(result.expired).toBe(1);
    const sides = result.matches[0]!.sides;
    expect(sides).toHaveLength(2);
    // The failed side stays silent with the default offenseCount (1)
    // and no penalty — consistent with first-offense semantics.
    const a = sides.find((s) => s.side === "A")!;
    expect(a.role).toBe("silent");
    expect(a.penalised).toBe(false);
  });
});
