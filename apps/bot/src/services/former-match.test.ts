import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reporting a partner who deleted their account (decision 2026-10-13). The
 * deletion cascades the match, so these cases pin the two halves that keep the
 * survivor's Report button working: the trace the deletion leaves, and where a
 * report filed through it lands — the tombstone, or the account the person
 * already came back as.
 */

const mocks = vi.hoisted(() => ({
  formerMatchFindUnique: vi.fn(),
  formerMatchFindFirst: vi.fn(),
  txQueryRaw: vi.fn(),
  txFormerMatchUpdateMany: vi.fn(),
  txTombstoneFindFirst: vi.fn(),
  txTombstoneFindMany: vi.fn(),
  txTombstoneUpdateMany: vi.fn(),
  txUserFindUnique: vi.fn(),
  txReportCreate: vi.fn(),
  applyReportAction: vi.fn(),
  notifyReportedUser: vi.fn(),
  claimMatches: vi.fn(),
  deliverEffects: vi.fn(),
  appendNegativeConstraint: vi.fn(),
}));

vi.mock("@gennety/db", () => {
  const tx = {
    $queryRaw: mocks.txQueryRaw,
    formerMatch: { updateMany: mocks.txFormerMatchUpdateMany },
    safetyTombstone: {
      findFirst: mocks.txTombstoneFindFirst,
      findMany: mocks.txTombstoneFindMany,
      updateMany: mocks.txTombstoneUpdateMany,
    },
    user: { findUnique: mocks.txUserFindUnique },
    report: { create: mocks.txReportCreate },
  };
  return {
    prisma: {
      formerMatch: {
        findUnique: mocks.formerMatchFindUnique,
        findFirst: mocks.formerMatchFindFirst,
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

const testEnv = vi.hoisted(() => ({ JWT_SECRET: "unit-test-secret", DEMO_MODE_ENABLED: false }));
vi.mock("../config.js", () => ({ env: testEnv }));
vi.mock("../public/jwt.js", () => ({ revokeAllSessions: vi.fn() }));
vi.mock("./founder-notify.js", () => ({ notifyFounderSafetyRestoreFailed: vi.fn() }));
vi.mock("./main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("./moderation.js", () => ({
  SUSPENSION_DAYS: 14,
  applyReportAction: mocks.applyReportAction,
  notifyReportedUser: mocks.notifyReportedUser,
  moderationOutcomeRequiresCancellation: (outcome: { kind: string }) =>
    outcome.kind !== "tier1" && outcome.kind !== "tier2_warning",
}));
vi.mock("./cancel-in-flight-matches.js", () => ({
  claimInFlightMatchCancellations: mocks.claimMatches,
  deliverCancelledPartnerEffects: mocks.deliverEffects,
}));
vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: mocks.appendNegativeConstraint,
}));

const { recordFormerMatches, fileFormerPartnerReport, applyReportToTombstones } = await import(
  "./former-match.js"
);

const GONE_ID = "11111111-1111-4111-8111-111111111111";
const SURVIVOR_ID = "22222222-2222-4222-8222-222222222222";
const RETURNED_ID = "33333333-3333-4333-8333-333333333333";
const MATCH_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-13T12:00:00Z");
const API = { token: "bot" } as never;

function input(overrides: Partial<Parameters<typeof fileFormerPartnerReport>[0]> = {}) {
  return {
    matchId: MATCH_ID,
    reporterId: SURVIVOR_ID,
    tier: 2 as const,
    rawText: "Category: Offensive",
    reasonSummary: "Reported offensive or disturbing behavior",
    enforce: true,
    adminReviewed: true,
    language: "en" as const,
    api: API,
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formerMatchFindUnique.mockResolvedValue({ formerUserId: GONE_ID, reportedAt: null });
  mocks.txQueryRaw.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
  mocks.txFormerMatchUpdateMany.mockResolvedValue({ count: 1 });
  mocks.txTombstoneFindFirst.mockResolvedValue(null);
  mocks.txTombstoneFindMany.mockResolvedValue([
    { status: null, suspendedUntil: null, strikes: 0 },
    { status: null, suspendedUntil: null, strikes: 0 },
  ]);
  mocks.txTombstoneUpdateMany.mockResolvedValue({ count: 2 });
  mocks.txUserFindUnique.mockResolvedValue({ id: RETURNED_ID });
  mocks.txReportCreate.mockResolvedValue({});
  mocks.applyReportAction.mockResolvedValue({ kind: "tier3_frozen" });
  mocks.claimMatches.mockResolvedValue([]);
  mocks.deliverEffects.mockResolvedValue(undefined);
  mocks.notifyReportedUser.mockResolvedValue(undefined);
  mocks.appendNegativeConstraint.mockResolvedValue(undefined);
});

describe("recordFormerMatches", () => {
  function db(matches: unknown[], reports: unknown[] = []) {
    return {
      match: { findMany: vi.fn().mockResolvedValue(matches) },
      report: { findMany: vi.fn().mockResolvedValue(reports) },
      formerMatch: {
        createMany: vi.fn(async ({ data }: { data: Array<{ reportedAt: Date | null }> }) => ({
          count: data.length,
        })),
      },
    };
  }

  it("keeps one trace per recent match, for the person on the other side", async () => {
    const client = db([
      { id: MATCH_ID, userAId: GONE_ID, userBId: SURVIVOR_ID },
      { id: "m-2", userAId: RETURNED_ID, userBId: GONE_ID },
    ]);

    const count = await recordFormerMatches(client as never, GONE_ID, NOW);

    expect(count).toBe(2);
    const where = client.match.findMany.mock.calls[0]![0].where;
    // Recent means moved or dated within the window — an old expired
    // proposal leaves nothing.
    expect(where.AND[1]).toEqual({
      OR: [
        { updatedAt: { gte: new Date("2026-09-13T12:00:00Z") } },
        { agreedTime: { gte: new Date("2026-09-13T12:00:00Z") } },
      ],
    });
    expect(client.formerMatch.createMany).toHaveBeenCalledWith({
      data: [
        { matchId: MATCH_ID, survivorId: SURVIVOR_ID, formerUserId: GONE_ID, reportedAt: null },
        { matchId: "m-2", survivorId: RETURNED_ID, formerUserId: GONE_ID, reportedAt: null },
      ],
      skipDuplicates: true,
    });
  });

  it("marks a match the survivor already reported, so the button says so instead of filing twice", async () => {
    const client = db(
      [{ id: MATCH_ID, userAId: GONE_ID, userBId: SURVIVOR_ID }],
      [{ reporterId: SURVIVOR_ID, matchId: MATCH_ID }],
    );

    await recordFormerMatches(client as never, GONE_ID, NOW);

    expect(client.formerMatch.createMany.mock.calls[0]![0].data[0].reportedAt).toEqual(NOW);
  });

  it("writes nothing when the account had no recent match", async () => {
    const client = db([]);

    expect(await recordFormerMatches(client as never, GONE_ID, NOW)).toBe(0);
    expect(client.formerMatch.createMany).not.toHaveBeenCalled();
  });
});

describe("fileFormerPartnerReport", () => {
  it("refuses a match the reporter has no trace of", async () => {
    mocks.formerMatchFindUnique.mockResolvedValue(null);

    expect(await fileFormerPartnerReport(input())).toBe("not_found");
    expect(mocks.txReportCreate).not.toHaveBeenCalled();
  });

  it("answers duplicate for a trace already reported", async () => {
    mocks.formerMatchFindUnique.mockResolvedValue({ formerUserId: GONE_ID, reportedAt: NOW });

    expect(await fileFormerPartnerReport(input())).toBe("duplicate");
    expect(mocks.txReportCreate).not.toHaveBeenCalled();
  });

  it("answers duplicate when a concurrent report claimed the trace first", async () => {
    mocks.txFormerMatchUpdateMany.mockResolvedValue({ count: 0 });

    expect(await fileFormerPartnerReport(input())).toBe("duplicate");
    expect(mocks.txReportCreate).not.toHaveBeenCalled();
  });

  it("files nothing when no tombstone is left to attach the report to", async () => {
    mocks.txQueryRaw.mockResolvedValue([]);

    expect(await fileFormerPartnerReport(input())).toBe("not_found");
    expect(mocks.txFormerMatchUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txReportCreate).not.toHaveBeenCalled();
  });

  it("stores the report against the former account and puts the strike on its tombstones", async () => {
    expect(await fileFormerPartnerReport(input())).toBe("filed");

    expect(mocks.txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reporterId: SURVIVOR_ID,
        reportedId: null,
        reportedFormerId: GONE_ID,
        matchId: null,
        tier: 2,
      }),
    });
    expect(mocks.txTombstoneUpdateMany).toHaveBeenCalledWith({
      where: { formerUserId: GONE_ID },
      data: { status: null, suspendedUntil: null, strikes: 1 },
    });
    // Nobody to act on or notify: the account is gone.
    expect(mocks.applyReportAction).not.toHaveBeenCalled();
    expect(mocks.notifyReportedUser).not.toHaveBeenCalled();
  });

  it("sends the report to the account the person already came back as, through the live engine", async () => {
    mocks.txTombstoneFindFirst.mockResolvedValue({ restoredToUserId: RETURNED_ID });
    mocks.claimMatches.mockResolvedValue([{ partnerId: "p" }]);

    expect(await fileFormerPartnerReport(input({ tier: 3, adminReviewed: false }))).toBe("filed");

    expect(mocks.txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reportedId: RETURNED_ID, reportedFormerId: null }),
    });
    expect(mocks.applyReportAction).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 3, reportedUserId: RETURNED_ID }),
      expect.anything(),
    );
    expect(mocks.claimMatches).toHaveBeenCalledWith(RETURNED_ID, expect.anything(), {
      strict: true,
    });
    expect(mocks.txTombstoneUpdateMany).not.toHaveBeenCalled();
    expect(mocks.deliverEffects).toHaveBeenCalledWith([{ partnerId: "p" }], API);
    expect(mocks.notifyReportedUser).toHaveBeenCalledWith(API, RETURNED_ID, {
      kind: "tier3_frozen",
    });
  });

  it("only records a report held for manual review", async () => {
    expect(
      await fileFormerPartnerReport(input({ tier: 3, enforce: false, adminReviewed: false })),
    ).toBe("filed");

    expect(mocks.txReportCreate).toHaveBeenCalled();
    expect(mocks.txTombstoneUpdateMany).not.toHaveBeenCalled();
    expect(mocks.appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("keeps Tier 1 the reporter's own: their future matches, nothing on the former account", async () => {
    expect(await fileFormerPartnerReport(input({ tier: 1 }))).toBe("filed");

    expect(mocks.txTombstoneUpdateMany).not.toHaveBeenCalled();
    expect(mocks.appendNegativeConstraint).toHaveBeenCalledWith(
      SURVIVOR_ID,
      "Reported offensive or disturbing behavior",
      "en",
    );
  });
});

describe("applyReportToTombstones", () => {
  function db(rows: unknown[]) {
    return {
      safetyTombstone: {
        findMany: vi.fn().mockResolvedValue(rows),
        updateMany: vi.fn().mockResolvedValue({ count: rows.length }),
      },
    };
  }

  it("suspends the stored record on the second strike", async () => {
    const client = db([{ status: null, suspendedUntil: null, strikes: 1 }]);

    expect(await applyReportToTombstones(client as never, GONE_ID, 2, NOW)).toEqual({
      status: "suspended",
      strikes: 2,
    });
    expect(client.safetyTombstone.updateMany.mock.calls[0]![0].data.suspendedUntil).toEqual(
      new Date("2026-10-27T12:00:00Z"),
    );
  });

  it("bans it on the third", async () => {
    const client = db([{ status: "suspended", suspendedUntil: new Date("2026-10-20"), strikes: 2 }]);

    expect(await applyReportToTombstones(client as never, GONE_ID, 2, NOW)).toEqual({
      status: "banned",
      strikes: 3,
    });
  });

  it("never turns a stored ban into a freeze", async () => {
    const client = db([{ status: "banned", suspendedUntil: null, strikes: 3 }]);

    expect(await applyReportToTombstones(client as never, GONE_ID, 3, NOW)).toEqual({
      status: "banned",
      strikes: 3,
    });
  });

  it("keeps a freeze when a second strike would only suspend", async () => {
    const client = db([{ status: "pending_investigation", suspendedUntil: null, strikes: 1 }]);

    expect(await applyReportToTombstones(client as never, GONE_ID, 2, NOW)).toEqual({
      status: "pending_investigation",
      strikes: 2,
    });
  });
});
