import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A13-H14: deleting an account used to erase its ban, its strikes, and every
 * report and block filed against it, so the same person could re-register with
 * the same Telegram id and come back clean. These cases pin both halves: what
 * the deletion transaction captures, and what a returning identity gets back.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  tombstoneFindFirst: vi.fn(),
  txQueryRaw: vi.fn(),
  txExecuteRaw: vi.fn(),
  txTombstoneFindMany: vi.fn(),
  txTombstoneUpdateMany: vi.fn(),
  txUserFindUnique: vi.fn(),
  txUserUpdate: vi.fn(),
  txReportUpdateMany: vi.fn(),
  txBlockUpdateMany: vi.fn(),
  revokeAllSessions: vi.fn(),
  claimMatches: vi.fn(),
  deliverEffects: vi.fn(),
  notifyRestoreFailed: vi.fn(),
}));

vi.mock("@gennety/db", () => {
  const tx = {
    $queryRaw: mocks.txQueryRaw,
    $executeRaw: mocks.txExecuteRaw,
    safetyTombstone: {
      findMany: mocks.txTombstoneFindMany,
      updateMany: mocks.txTombstoneUpdateMany,
    },
    user: { findUnique: mocks.txUserFindUnique, update: mocks.txUserUpdate },
    report: { updateMany: mocks.txReportUpdateMany },
    userBlock: { updateMany: mocks.txBlockUpdateMany },
  };
  return {
    prisma: {
      user: { findUnique: mocks.userFindUnique },
      safetyTombstone: { findFirst: mocks.tombstoneFindFirst },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

const testEnv = vi.hoisted(() => ({ JWT_SECRET: "unit-test-secret" }));
vi.mock("../config.js", () => ({ env: testEnv }));
vi.mock("../public/jwt.js", () => ({ revokeAllSessions: mocks.revokeAllSessions }));
vi.mock("./cancel-in-flight-matches.js", () => ({
  claimInFlightMatchCancellations: mocks.claimMatches,
  deliverCancelledPartnerEffects: mocks.deliverEffects,
}));
vi.mock("./founder-notify.js", () => ({
  notifyFounderSafetyRestoreFailed: mocks.notifyRestoreFailed,
}));
vi.mock("./main-bot-api.js", () => ({ getMainBotApi: () => null }));

const {
  restoreSafetyHistory,
  restoreSafetyHistoryAfterAttach,
  safetyIdentitiesOf,
  writeSafetyTombstones,
} = await import("./safety-tombstone.js");

const FORMER_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-14T12:00:00Z");

const IDENTITY = {
  telegramId: 4242n,
  phone: "+380501234567",
  phoneVerifiedAt: new Date("2026-08-01T00:00:00Z"),
  email: "Ana@Uni.Edu",
  isEmailVerified: true,
};

/** The transaction client `writeSafetyTombstones` receives, as a stub. */
function deletionTx(user: Record<string, unknown> | null, against: { reports: number; blocks: number }) {
  return {
    user: { findUnique: vi.fn(async () => user) },
    report: {
      count: vi.fn(async () => against.reports),
      updateMany: vi.fn(async () => ({ count: against.reports })),
      deleteMany: vi.fn(async () => ({ count: against.reports })),
    },
    userBlock: {
      count: vi.fn(async () => against.blocks),
      updateMany: vi.fn(async () => ({ count: against.blocks })),
      deleteMany: vi.fn(async () => ({ count: against.blocks })),
    },
    safetyTombstone: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testEnv.JWT_SECRET = "unit-test-secret";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.userFindUnique.mockResolvedValue({ ...IDENTITY });
  mocks.tombstoneFindFirst.mockResolvedValue({ id: "t1" });
  mocks.txQueryRaw.mockResolvedValue([]);
  mocks.txExecuteRaw.mockResolvedValue(0);
  mocks.txTombstoneFindMany.mockResolvedValue([
    { formerUserId: FORMER_ID, status: "banned", suspendedUntil: null, strikes: 3 },
  ]);
  mocks.txTombstoneUpdateMany.mockResolvedValue({ count: 3 });
  mocks.txUserFindUnique.mockResolvedValue({ status: "onboarding", strikes: 0, suspendedUntil: null });
  mocks.txUserUpdate.mockResolvedValue({});
  mocks.txReportUpdateMany.mockResolvedValue({ count: 2 });
  mocks.txBlockUpdateMany.mockResolvedValue({ count: 1 });
  mocks.revokeAllSessions.mockResolvedValue(undefined);
  mocks.claimMatches.mockResolvedValue([]);
  mocks.deliverEffects.mockResolvedValue(undefined);
  mocks.notifyRestoreFailed.mockResolvedValue(undefined);
});

describe("safetyIdentitiesOf", () => {
  it("hashes every PROVEN identity, and nothing in the clear", () => {
    const identities = safetyIdentitiesOf(IDENTITY, "secret");
    expect(identities.map((identity) => identity.kind)).toEqual(["telegram", "phone", "email"]);
    for (const identity of identities) {
      expect(identity.identityHash).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.identityHash).not.toContain("4242");
    }
  });

  it("skips a synthetic Telegram id, an unverified phone and an unverified email", () => {
    const identities = safetyIdentitiesOf(
      { telegramId: -99n, phone: "+380501234567", phoneVerifiedAt: null, email: "x@uni.edu", isEmailVerified: false },
      "secret",
    );
    expect(identities).toEqual([]);
  });

  it("normalises the email, so a case change is the same identity", () => {
    const [upper] = safetyIdentitiesOf({ ...IDENTITY, telegramId: -1n, phone: null }, "secret");
    const [lower] = safetyIdentitiesOf(
      { ...IDENTITY, telegramId: -1n, phone: null, email: " ana@uni.edu " },
      "secret",
    );
    expect(upper?.identityHash).toBe(lower?.identityHash);
  });

  it("depends on the key — a rotated JWT_SECRET matches nothing old", () => {
    const [a] = safetyIdentitiesOf(IDENTITY, "secret-a");
    const [b] = safetyIdentitiesOf(IDENTITY, "secret-b");
    expect(a?.identityHash).not.toBe(b?.identityHash);
  });

  it("produces nothing without a secret rather than a weakly keyed hash", () => {
    expect(safetyIdentitiesOf(IDENTITY, "")).toEqual([]);
  });
});

describe("writeSafetyTombstones (inside the deletion transaction)", () => {
  it("writes one tombstone per identity for a banned user and stamps what was filed against them", async () => {
    const tx = deletionTx(
      { ...IDENTITY, status: "banned", strikes: 3, suspendedUntil: null },
      { reports: 2, blocks: 1 },
    );

    const result = await writeSafetyTombstones(tx as never, FORMER_ID, "secret");

    expect(result).toMatchObject({ tombstones: 3, reportsKept: 2, blocksKept: 1 });
    const rows = tx.safetyTombstone.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.kind)).toEqual(["telegram", "phone", "email"]);
    for (const row of rows) {
      expect(row).toMatchObject({ formerUserId: FORMER_ID, status: "banned", strikes: 3, suspendedUntil: null });
      expect(JSON.stringify(row)).not.toContain(IDENTITY.phone);
      expect(JSON.stringify(row).toLowerCase()).not.toContain("ana@uni.edu");
    }
    expect(tx.report.updateMany).toHaveBeenCalledWith({
      where: { reportedId: FORMER_ID },
      data: { reportedFormerId: FORMER_ID },
    });
    expect(tx.userBlock.updateMany).toHaveBeenCalledWith({
      where: { blockedId: FORMER_ID },
      data: { blockedFormerId: FORMER_ID },
    });
  });

  it("carries a suspension with its end date", async () => {
    const until = new Date("2026-09-20T00:00:00Z");
    const tx = deletionTx(
      { ...IDENTITY, status: "suspended", strikes: 2, suspendedUntil: until },
      { reports: 0, blocks: 0 },
    );
    await writeSafetyTombstones(tx as never, FORMER_ID, "secret");
    const rows = tx.safetyTombstone.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ status: "suspended", suspendedUntil: until, strikes: 2 });
  });

  it("leaves nothing behind for a clean record", async () => {
    const tx = deletionTx({ ...IDENTITY, status: "active", strikes: 0, suspendedUntil: null }, { reports: 0, blocks: 0 });
    const result = await writeSafetyTombstones(tx as never, FORMER_ID, "secret");
    expect(result.tombstones).toBe(0);
    expect(tx.safetyTombstone.createMany).not.toHaveBeenCalled();
    expect(tx.report.updateMany).not.toHaveBeenCalled();
  });

  it("carries a report against an otherwise clean account (the blocked or reported side)", async () => {
    const tx = deletionTx({ ...IDENTITY, status: "active", strikes: 0, suspendedUntil: null }, { reports: 0, blocks: 1 });
    const result = await writeSafetyTombstones(tx as never, FORMER_ID, "secret");
    expect(result.tombstones).toBe(3);
    const rows = tx.safetyTombstone.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ status: null, strikes: 0 });
  });

  it("drops reports and blocks it can never relink when there is no identity to key on", async () => {
    const tx = deletionTx(
      { telegramId: -5n, phone: null, phoneVerifiedAt: null, email: null, isEmailVerified: false, status: "banned", strikes: 3, suspendedUntil: null },
      { reports: 1, blocks: 1 },
    );
    const result = await writeSafetyTombstones(tx as never, FORMER_ID, "secret");
    expect(result).toMatchObject({ tombstones: 0, reportsDropped: 1, blocksDropped: 1 });
    expect(tx.safetyTombstone.createMany).not.toHaveBeenCalled();
    expect(tx.report.deleteMany).toHaveBeenCalledWith({ where: { reportedId: FORMER_ID } });
  });

  it("supersedes tombstones already applied to this account before capturing its current state", async () => {
    const tx = deletionTx({ ...IDENTITY, status: "active", strikes: 1, suspendedUntil: null }, { reports: 0, blocks: 0 });
    await writeSafetyTombstones(tx as never, FORMER_ID, "secret");
    expect(tx.safetyTombstone.deleteMany).toHaveBeenCalledWith({ where: { restoredToUserId: FORMER_ID } });
    expect(tx.safetyTombstone.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.safetyTombstone.createMany.mock.invocationCallOrder[0]!,
    );
  });
});

describe("restoreSafetyHistory (re-registration)", () => {
  it("restores a ban, relinks reports and blocks, revokes sessions and cancels live matches", async () => {
    mocks.claimMatches.mockResolvedValueOnce([{ matchId: "m1" }]);

    const result = await restoreSafetyHistory(NEW_ID, { now: NOW });

    expect(result).toEqual({
      applied: true,
      statusRestored: "banned",
      strikesRestored: 3,
      reportsRelinked: 2,
      blocksRelinked: 1,
      cancelledMatches: 1,
    });
    // Row lock first, so concurrent restores for one account serialise.
    expect(mocks.txQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txTombstoneFindMany.mock.invocationCallOrder[0]!,
    );
    expect(mocks.txReportUpdateMany).toHaveBeenCalledWith({
      where: { reportedId: null, reportedFormerId: { in: [FORMER_ID] } },
      data: { reportedId: NEW_ID, reportedFormerId: null },
    });
    // The unique-collision cleanup runs before the relink it protects.
    expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txBlockUpdateMany.mock.invocationCallOrder[0]!,
    );
    expect(mocks.txBlockUpdateMany).toHaveBeenCalledWith({
      where: { blockedId: null, blockedFormerId: { in: [FORMER_ID] } },
      data: { blockedId: NEW_ID, blockedFormerId: null },
    });
    expect(mocks.txUserUpdate).toHaveBeenCalledWith({
      where: { id: NEW_ID },
      data: { status: "banned", strikes: 3 },
    });
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith(NEW_ID, expect.anything());
    expect(mocks.claimMatches).toHaveBeenCalledWith(NEW_ID, expect.anything(), { strict: true });
    expect(mocks.txTombstoneUpdateMany).toHaveBeenCalledWith({
      where: { formerUserId: { in: [FORMER_ID] } },
      data: { restoredToUserId: NEW_ID, restoredAt: NOW },
    });
    expect(mocks.deliverEffects).toHaveBeenCalledWith([{ matchId: "m1" }], null);
  });

  it("looks tombstones up by the account's hashed identities, skipping ones already applied to it", async () => {
    await restoreSafetyHistory(NEW_ID, { now: NOW });

    const where = mocks.tombstoneFindFirst.mock.calls[0]![0].where;
    expect(where.identityHash.in).toEqual(
      safetyIdentitiesOf(IDENTITY, "unit-test-secret").map((identity) => identity.identityHash),
    );
    expect(where.OR).toEqual([{ restoredToUserId: null }, { restoredToUserId: { not: NEW_ID } }]);
    expect(mocks.txTombstoneFindMany.mock.calls[0]![0].where).toEqual(where);
  });

  it("is a cheap no-op when nothing applies — no transaction, no lock", async () => {
    mocks.tombstoneFindFirst.mockResolvedValueOnce(null);
    const { prisma } = await import("@gennety/db");

    const result = await restoreSafetyHistory(NEW_ID, { now: NOW });

    expect(result.applied).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("never touches the database without a secret", async () => {
    testEnv.JWT_SECRET = "";
    const result = await restoreSafetyHistory(NEW_ID, { now: NOW });
    expect(result.applied).toBe(false);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });

  it("keeps the stricter status the account already has", async () => {
    mocks.txTombstoneFindMany.mockResolvedValueOnce([
      { formerUserId: FORMER_ID, status: "suspended", suspendedUntil: new Date("2026-09-30T00:00:00Z"), strikes: 2 },
    ]);
    mocks.txUserFindUnique.mockResolvedValueOnce({ status: "banned", strikes: 3, suspendedUntil: null });

    const result = await restoreSafetyHistory(NEW_ID, { now: NOW });

    expect(result.statusRestored).toBeNull();
    expect(mocks.txUserUpdate).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("does not restore a suspension that has already run out", async () => {
    mocks.txTombstoneFindMany.mockResolvedValueOnce([
      { formerUserId: FORMER_ID, status: "suspended", suspendedUntil: new Date("2026-09-01T00:00:00Z"), strikes: 2 },
    ]);

    const result = await restoreSafetyHistory(NEW_ID, { now: NOW });

    expect(result.statusRestored).toBeNull();
    expect(mocks.txUserUpdate).toHaveBeenCalledWith({ where: { id: NEW_ID }, data: { strikes: 2 } });
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("restores a still-running suspension with its end date", async () => {
    const until = new Date("2026-09-30T00:00:00Z");
    mocks.txTombstoneFindMany.mockResolvedValueOnce([
      { formerUserId: FORMER_ID, status: "suspended", suspendedUntil: until, strikes: 2 },
    ]);

    const result = await restoreSafetyHistory(NEW_ID, { now: NOW });

    expect(result.statusRestored).toBe("suspended");
    expect(mocks.txUserUpdate).toHaveBeenCalledWith({
      where: { id: NEW_ID },
      data: { status: "suspended", suspendedUntil: until, strikes: 2 },
    });
    expect(mocks.revokeAllSessions).toHaveBeenCalled();
  });
});

describe("restoreSafetyHistoryAfterAttach", () => {
  it("never throws into the login, but is not silent: it logs and alerts the founder", async () => {
    mocks.userFindUnique.mockRejectedValueOnce(new Error("db down"));

    await expect(restoreSafetyHistoryAfterAttach(NEW_ID, "mobile:phone-login")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
    expect(mocks.notifyRestoreFailed).toHaveBeenCalledWith({
      userId: NEW_ID,
      source: "mobile:phone-login",
      error: "db down",
    });
  });
});
