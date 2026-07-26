/**
 * Unit tests for the paid Rematch core (REMATCH_PRODUCT_SPEC.md).
 *
 * Focus is the two things that can actually hurt: who may BUY (D3 limits and the
 * single-live-match rule) and who may be DELIVERED (the gift cap). Prisma is a
 * small in-memory stand-in mirroring the exact reads the service performs, and
 * the engine is mocked so these tests exercise the orchestration, not the
 * matching algorithm (which has its own suites).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const flag = {
  REMATCH_FEATURE_ENABLED: true,
  REMATCH_MAX_PER_WEEK: 2,
  REMATCH_COOLDOWN_HOURS: 24,
  REMATCH_GIFT_CAP_DAYS: 7,
  REMATCH_PRE_BATCH_BLACKOUT_HOURS: 0,
  REMATCH_FAILED_LOOKBACK_DAYS: 14,
};
vi.mock("../config.js", () => ({ env: flag }));

interface UserRow {
  id: string;
  gender: string | null;
  status: string;
  onboardingStep: string;
  verificationStatus: string;
  verificationSkippedAt: Date | null;
}

interface MatchRow {
  id: string;
  userAId: string;
  userBId: string;
  status: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

interface PurchaseRow {
  id: string;
  userId: string;
  status: string;
  createdAt: Date;
  resultMatchId: string | null;
  framing: string | null;
}

const db = {
  users: [] as UserRow[],
  matches: [] as MatchRow[],
  purchases: [] as PurchaseRow[],
  noMatchNotices: [] as { userId: string; dropDate: Date }[],
  profileUpdates: [] as { userIds: string[]; data: unknown }[],
};

const prismaMock = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      db.users.find((u) => u.id === where.id) ?? null,
  },
  match: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const statusIn = (where.status as { in?: string[] } | undefined)?.in;
      const or = where.OR as Array<Record<string, string>> | undefined;
      const notId = (where.id as { not?: string } | undefined)?.not;
      const found = db.matches.find((m) => {
        if (statusIn && !statusIn.includes(m.status)) return false;
        if (notId && m.id === notId) return false;
        if (or) {
          const hit = or.some(
            (clause) =>
              (clause.userAId && clause.userAId === m.userAId) ||
              (clause.userBId && clause.userBId === m.userBId),
          );
          if (!hit) return false;
        }
        return true;
      });
      return found ? { id: found.id } : null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const source = where.source as string | undefined;
      const gte = (where.createdAt as { gte?: Date } | undefined)?.gte;
      const or = where.OR as Array<Record<string, { in: string[] }>> | undefined;
      return db.matches
        .filter((m) => {
          if (source && m.source !== source) return false;
          if (gte && m.createdAt < gte) return false;
          if (or) {
            const ids = or.flatMap((c) => c.userAId?.in ?? c.userBId?.in ?? []);
            if (!ids.includes(m.userAId) && !ids.includes(m.userBId)) return false;
          }
          return true;
        })
        .map((m) => ({ userAId: m.userAId, userBId: m.userBId }));
    },
  },
  rematchPurchase: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const gte = (where.createdAt as { gte?: Date } | undefined)?.gte;
      return db.purchases
        .filter(
          (p) =>
            p.userId === where.userId &&
            p.status === where.status &&
            (!gte || p.createdAt >= gte),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((p) => ({ createdAt: p.createdAt }));
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const found = db.purchases.find(
        (p) => p.resultMatchId === where.resultMatchId && p.status === where.status,
      );
      return found ? { framing: found.framing } : null;
    },
  },
  noMatchNotice: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const gte = (where.dropDate as { gte?: Date } | undefined)?.gte;
      const found = db.noMatchNotices.find(
        (n) => n.userId === where.userId && (!gte || n.dropDate >= gte),
      );
      return found ? { id: "n1" } : null;
    },
  },
  profile: {
    updateMany: async ({ where, data }: { where: { userId: { in: string[] } }; data: unknown }) => {
      db.profileUpdates.push({ userIds: where.userId.in, data });
      return { count: where.userId.in.length };
    },
  },
};
vi.mock("@gennety/db", () => ({ prisma: prismaMock }));

const findCandidatesFor = vi.fn();
const createProposedMatch = vi.fn();
vi.mock("./match-engine.js", () => ({
  findCandidatesFor: (...args: unknown[]) => findCandidatesFor(...args),
  createProposedMatch: (...args: unknown[]) => createProposedMatch(...args),
}));

vi.mock("./next-batch.js", () => ({
  getNextBatchDate: () => new Date("2026-08-06T18:00:00Z"),
}));

const {
  checkRematchEligibility,
  findRematchCandidate,
  pickGiftFraming,
  getGiftFramingForMatch,
  runRematch,
} = await import("./rematch.js");

const NOW = new Date("2026-08-01T12:00:00Z");
const BUYER = "buyer-1";

function seedBuyer(overrides: Partial<UserRow> = {}): void {
  db.users.push({
    id: BUYER,
    gender: "male",
    status: "active",
    onboardingStep: "completed",
    verificationStatus: "verified",
    verificationSkippedAt: null,
    ...overrides,
  });
}

function candidate(userId: string) {
  return {
    userId,
    telegramId: 10n,
    firstName: "Ann",
    score: 0.9,
    breakdown: {
      explicit: 0.8,
      research: 0.6,
      league: 1,
      penalty: 0,
      agePref: 1,
      type: 1,
    },
  };
}

beforeEach(() => {
  db.users = [];
  db.matches = [];
  db.purchases = [];
  db.noMatchNotices = [];
  db.profileUpdates = [];
  findCandidatesFor.mockReset();
  createProposedMatch.mockReset();
  flag.REMATCH_FEATURE_ENABLED = true;
  flag.REMATCH_MAX_PER_WEEK = 2;
  flag.REMATCH_COOLDOWN_HOURS = 24;
  flag.REMATCH_GIFT_CAP_DAYS = 7;
  flag.REMATCH_PRE_BATCH_BLACKOUT_HOURS = 0;
});

describe("checkRematchEligibility", () => {
  it("allows an active verified male with no history", async () => {
    seedBuyer();
    expect(await checkRematchEligibility(BUYER, NOW)).toEqual({ ok: true });
  });

  it("refuses when the feature is off", async () => {
    seedBuyer();
    flag.REMATCH_FEATURE_ENABLED = false;
    expect((await checkRematchEligibility(BUYER, NOW)).reason).toBe("feature_off");
  });

  it("refuses a female buyer — v1 is male-only, women receive rematches as a gift", async () => {
    seedBuyer({ gender: "female" });
    expect((await checkRematchEligibility(BUYER, NOW)).reason).toBe("not_male");
  });

  it("refuses an unverified buyer — a paid run never lowers the admission bar", async () => {
    seedBuyer({ verificationStatus: "pending" });
    expect((await checkRematchEligibility(BUYER, NOW)).reason).toBe("not_matchable");
  });

  it("refuses while a live match is in flight (single-live-match invariant)", async () => {
    seedBuyer();
    db.matches.push({
      id: "m1",
      userAId: BUYER,
      userBId: "x",
      status: "proposed",
      source: "weekly",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect((await checkRematchEligibility(BUYER, NOW)).reason).toBe("live_match");
  });

  it("refuses past the weekly limit and reports when it frees up", async () => {
    seedBuyer();
    const first = new Date(NOW.getTime() - 5 * 24 * 3600_000);
    db.purchases.push(
      { id: "p1", userId: BUYER, status: "settled", createdAt: first, resultMatchId: null, framing: null },
      {
        id: "p2",
        userId: BUYER,
        status: "settled",
        createdAt: new Date(NOW.getTime() - 2 * 24 * 3600_000),
        resultMatchId: null,
        framing: null,
      },
    );
    const result = await checkRematchEligibility(BUYER, NOW);
    expect(result.reason).toBe("weekly_limit");
    // Frees up when the OLDEST purchase in the window ages out.
    expect(result.retryAt).toEqual(new Date(first.getTime() + 7 * 24 * 3600_000));
  });

  it("refunded purchases do NOT consume quota", async () => {
    seedBuyer();
    db.purchases.push(
      {
        id: "p1",
        userId: BUYER,
        status: "refunded_no_candidate",
        createdAt: new Date(NOW.getTime() - 3 * 24 * 3600_000),
        resultMatchId: null,
        framing: null,
      },
      {
        id: "p2",
        userId: BUYER,
        status: "refunded_ineligible",
        createdAt: new Date(NOW.getTime() - 2 * 24 * 3600_000),
        resultMatchId: null,
        framing: null,
      },
    );
    expect(await checkRematchEligibility(BUYER, NOW)).toEqual({ ok: true });
  });

  it("refuses inside the 24h cooldown — no decline-and-instantly-retry", async () => {
    seedBuyer();
    const last = new Date(NOW.getTime() - 3 * 3600_000);
    db.purchases.push({
      id: "p1",
      userId: BUYER,
      status: "settled",
      createdAt: last,
      resultMatchId: null,
      framing: null,
    });
    const result = await checkRematchEligibility(BUYER, NOW);
    expect(result.reason).toBe("cooldown");
    expect(result.retryAt).toEqual(new Date(last.getTime() + 24 * 3600_000));
  });

  it("refuses inside the pre-batch blackout", async () => {
    seedBuyer();
    flag.REMATCH_PRE_BATCH_BLACKOUT_HOURS = 6;
    // Batch is mocked at 2026-08-06T18:00Z; 14:00 the same day is inside 6h.
    const result = await checkRematchEligibility(BUYER, new Date("2026-08-06T14:00:00Z"));
    expect(result.reason).toBe("pre_batch_blackout");
  });
});

describe("findRematchCandidate", () => {
  it("returns the top-ranked candidate", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([candidate("w1"), candidate("w2")]);
    const found = await findRematchCandidate(BUYER, NOW);
    expect(found?.userId).toBe("w1");
  });

  it("skips a candidate gift-pitched within the cap window, taking the next best", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([candidate("w1"), candidate("w2")]);
    db.matches.push({
      id: "m-prev",
      userAId: "someone-else",
      userBId: "w1",
      status: "cancelled",
      source: "rematch",
      createdAt: new Date(NOW.getTime() - 2 * 24 * 3600_000),
      updatedAt: NOW,
    });
    const found = await findRematchCandidate(BUYER, NOW);
    expect(found?.userId).toBe("w2");
  });

  it("ignores a rematch pitch older than the cap window", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([candidate("w1")]);
    db.matches.push({
      id: "m-old",
      userAId: "someone-else",
      userBId: "w1",
      status: "cancelled",
      source: "rematch",
      createdAt: new Date(NOW.getTime() - 30 * 24 * 3600_000),
      updatedAt: NOW,
    });
    expect((await findRematchCandidate(BUYER, NOW))?.userId).toBe("w1");
  });

  it("returns null when the engine has nobody — the refundable outcome", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([]);
    expect(await findRematchCandidate(BUYER, NOW)).toBeNull();
  });

  it("returns null when every ranked candidate is gift-capped", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([candidate("w1")]);
    db.matches.push({
      id: "m-prev",
      userAId: "x",
      userBId: "w1",
      status: "proposed",
      source: "rematch",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await findRematchCandidate(BUYER, NOW)).toBeNull();
  });
});

describe("pickGiftFraming", () => {
  it("prefers famine when she was told there was no match this week", async () => {
    db.noMatchNotices.push({ userId: "w1", dropDate: new Date(NOW.getTime() - 2 * 3600_000) });
    expect(await pickGiftFraming("w1", NOW)).toBe("famine");
  });

  it("uses failed when her last match ended badly", async () => {
    db.matches.push({
      id: "m1",
      userAId: "w1",
      userBId: "x",
      status: "cancelled",
      source: "weekly",
      createdAt: NOW,
      updatedAt: new Date(NOW.getTime() - 3 * 24 * 3600_000),
    });
    expect(await pickGiftFraming("w1", NOW)).toBe("failed");
  });

  it("does not treat the just-created rematch as her failed history", async () => {
    db.matches.push({
      id: "m-new",
      userAId: "w1",
      userBId: BUYER,
      status: "cancelled",
      source: "rematch",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await pickGiftFraming("w1", NOW, "m-new")).toBe("neutral");
  });

  it("falls back to neutral", async () => {
    expect(await pickGiftFraming("w1", NOW)).toBe("neutral");
  });
});

describe("getGiftFramingForMatch", () => {
  it("reads back the framing persisted at purchase", async () => {
    db.purchases.push({
      id: "p1",
      userId: BUYER,
      status: "settled",
      createdAt: NOW,
      resultMatchId: "m1",
      framing: "famine",
    });
    expect(await getGiftFramingForMatch("m1")).toBe("famine");
  });

  it("returns null for a non-rematch match", async () => {
    expect(await getGiftFramingForMatch("m-unknown")).toBeNull();
  });
});

describe("runRematch", () => {
  it("creates a rematch-stamped pair and clears both famine counters", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([candidate("w1")]);
    createProposedMatch.mockResolvedValue({ id: "m-new" });

    const result = await runRematch(BUYER, NOW);

    expect(result.ok).toBe(true);
    expect(result.matchId).toBe("m-new");
    expect(result.partnerId).toBe("w1");
    // The pair must be stamped inside the creating transaction, not after.
    const allocation = createProposedMatch.mock.calls[0]?.[4];
    expect(allocation).toEqual({ source: "rematch", rematchPaidById: BUYER });
    // Mirrors the weekly batch: a successful pairing resets starvation.
    expect(db.profileUpdates).toEqual([
      { userIds: [BUYER, "w1"], data: { standbyCount: 0, missedWeeks: 0 } },
    ]);
  });

  it("reports no_candidate (the refundable outcome) when nobody is left", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([]);
    const result = await runRematch(BUYER, NOW);
    expect(result).toEqual({ ok: false, reason: "no_candidate" });
    expect(createProposedMatch).not.toHaveBeenCalled();
  });

  it("reports create_failed when the in-transaction re-check refuses", async () => {
    seedBuyer();
    findCandidatesFor.mockResolvedValue([candidate("w1")]);
    createProposedMatch.mockResolvedValue(null);
    const result = await runRematch(BUYER, NOW);
    expect(result).toEqual({ ok: false, reason: "create_failed" });
    // Nothing was delivered, so no starvation reset may have happened.
    expect(db.profileUpdates).toEqual([]);
  });

  it("re-validates eligibility and never runs the engine for an ineligible buyer", async () => {
    seedBuyer({ gender: "female" });
    const result = await runRematch(BUYER, NOW);
    expect(result).toEqual({ ok: false, reason: "not_male" });
    expect(findCandidatesFor).not.toHaveBeenCalled();
  });
});
