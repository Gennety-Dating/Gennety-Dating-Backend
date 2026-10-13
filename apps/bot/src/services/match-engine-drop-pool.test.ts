import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The drop reads vectors only where it needs them.
 *
 *   1. A city past the per-city cap: who is in is decided from whether each
 *      user HAS an embedding — the cap never reads the vector — and vectors are
 *      read for the kept users only. The plan must be the one the pre-change
 *      planner produced by reading every vector first (`referencePlan` below is
 *      that planner, verbatim, over the still-unchanged `loadEligibleUsers`).
 *   2. The standby update after the drop needs only the ids of the users who
 *      are still eligible, so it no longer reads their vectors at all.
 */

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  userUpdateMany: vi.fn(),
  matchFindMany: vi.fn(),
  matchUpdateMany: vi.fn(),
  userBlockFindMany: vi.fn(),
  profileUpdateMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  refreshAllDirtyEmbeddings: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany, updateMany: mocks.userUpdateMany },
    match: { findMany: mocks.matchFindMany, updateMany: mocks.matchUpdateMany },
    userBlock: { findMany: mocks.userBlockFindMany },
    profile: { updateMany: mocks.profileUpdateMany },
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $transaction: mocks.transaction,
  },
}));

vi.mock("../workers/embedding-refresh.js", () => ({
  refreshAllDirtyEmbeddings: mocks.refreshAllDirtyEmbeddings,
}));

import {
  capPoolPerCity,
  computePairwiseDistances,
  greedyPair,
  loadEligibleUsers,
  previewDropBatch,
  runDropBatch,
  scorePair,
  type BatchUser,
  type DropBatchPlan,
  type ScoredPair,
} from "./match-engine.js";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

interface Row {
  id: string;
  age: number;
  gender: "male" | "female";
  major: string | null;
  preference: "men" | "women";
  universityDomain: string | null;
  profile: {
    height: number;
    negativeConstraints: string | null;
    psychologicalSummary: string;
    energyAxis: number;
    orientationAxis: number;
    eloScore: number;
    standbyCount: number;
    homeCityKey: string;
    ageRangeMin: null;
    ageRangeMax: null;
    typePrefTags: null;
    appearanceTags: null;
    relationshipIntents: string[];
  };
}

let ROWS: Row[] = [];
let VECTORS = new Map<string, string | null>();

function row(n: number, gender: "male" | "female", city: string, standbyCount: number): Row {
  return {
    id: uuid(n),
    age: 19 + (n % 9),
    gender,
    major: n % 3 === 0 ? "Computer Science" : "History",
    preference: gender === "male" ? "women" : "men",
    universityDomain: "knu.ua",
    profile: {
      height: 160 + (n % 30),
      negativeConstraints: n % 4 === 0 ? "- [lifestyle] avoid [smoker]" : null,
      psychologicalSummary: n % 5 === 0 ? "a calm smoker" : "curious runner",
      energyAxis: ((n * 37) % 200) / 100 - 1,
      orientationAxis: ((n * 53) % 200) / 100 - 1,
      eloScore: 400 + ((n * 17) % 200),
      standbyCount,
      homeCityKey: city,
      ageRangeMin: null,
      ageRangeMax: null,
      typePrefTags: null,
      appearanceTags: null,
      relationshipIntents: [],
    },
  };
}

function vector(n: number): string {
  return `[${[1, 2, 3, 4].map((k) => (((n * k * 7919) % 1000) / 1000 - 0.5).toFixed(3)).join(",")}]`;
}

function serveFixture() {
  mocks.userFindMany.mockImplementation(
    async (arg: { where: { id?: { in: string[] }; profile: { lastMatchedAt: unknown } } }) => {
      if (arg.where.profile.lastMatchedAt === null) return [];
      const wanted = arg.where.id?.in;
      return wanted ? ROWS.filter((r) => wanted.includes(r.id)) : ROWS;
    },
  );
  mocks.queryRawUnsafe.mockImplementation(async (sql: string, ids: string[]) => {
    if (sql.includes("embedding::text")) {
      return ids.map((id) => ({ user_id: id, embedding: VECTORS.get(id) ?? null }));
    }
    if (sql.includes("embedding IS NOT NULL")) {
      return ids.filter((id) => VECTORS.get(id)).map((id) => ({ user_id: id }));
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

function literalQueryIds(): string[][] {
  return mocks.queryRawUnsafe.mock.calls
    .filter(([sql]) => String(sql).includes("embedding::text"))
    .map(([, ids]) => ids as string[]);
}

function presenceQueryIds(): string[][] {
  return mocks.queryRawUnsafe.mock.calls
    .filter(([sql]) => String(sql).includes("embedding IS NOT NULL"))
    .map(([, ids]) => ids as string[]);
}

/** The planner as it was before the change: every vector first, then the cap. */
async function referencePlan(): Promise<DropBatchPlan> {
  const eligible = await loadEligibleUsers();
  const { kept: users, cut: carried } = capPoolPerCity(eligible);
  const userMap = new Map<string, BatchUser>(users.map((u) => [u.id, u]));
  const distances = await computePairwiseDistances(users);
  const scoredPairs: ScoredPair[] = [];
  for (const [key, distance] of distances) {
    const [aId, bId] = key.split(":");
    const a = userMap.get(aId!)!;
    const b = userMap.get(bId!)!;
    const { score, breakdown } = scorePair(a, b, distance);
    scoredPairs.push({
      userAId: aId!,
      userBId: bId!,
      score,
      breakdown,
      allocationFingerprints: {
        userA: a.allocationFingerprint ?? "",
        userB: b.allocationFingerprint ?? "",
      },
    });
  }
  const finalPairs = greedyPair(scoredPairs);
  const pairedIds = new Set(finalPairs.flatMap((p) => [p.userAId, p.userBId]));
  return {
    eligible: eligible.length,
    pairs: finalPairs.length,
    finalPairs,
    missedUserIds: [
      ...users.filter((u) => !pairedIds.has(u.id)).map((u) => u.id),
      ...carried.map((u) => u.id),
    ],
  };
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.matchFindMany.mockResolvedValue([]);
  mocks.userBlockFindMany.mockResolvedValue([]);
  mocks.userUpdateMany.mockResolvedValue({ count: 0 });
  mocks.matchUpdateMany.mockResolvedValue({ count: 0 });
  mocks.profileUpdateMany.mockImplementation(async (arg: unknown) => arg);
  mocks.transaction.mockImplementation(async (ops: unknown[]) => ops);
  mocks.refreshAllDirtyEmbeddings.mockResolvedValue({ scanned: 0, refreshed: 0, failed: 0, stillDirty: 0 });
  serveFixture();
});

describe("a city past the per-city cap", () => {
  beforeEach(() => {
    ROWS = [];
    VECTORS = new Map();
    let n = 1;
    // Kyiv: 420 men and 12 women with an embedding, plus 14 men WITHOUT one
    // who have waited longest — if a missing embedding took a cap slot, the
    // cut below would change.
    for (let i = 0; i < 420; i++, n++) {
      ROWS.push(row(n, "male", "ua:kyiv", (n * 7) % 5));
      VECTORS.set(uuid(n), vector(n));
    }
    for (let i = 0; i < 12; i++, n++) {
      ROWS.push(row(n, "female", "ua:kyiv", (n * 3) % 4));
      VECTORS.set(uuid(n), vector(n));
    }
    for (let i = 0; i < 14; i++, n++) {
      ROWS.push(row(n, "male", "ua:kyiv", 9));
      VECTORS.set(uuid(n), null);
    }
    // Berlin, under the cap, interleaved with Kyiv in scan order.
    for (let i = 0; i < 16; i++, n++) {
      const at = 5 + i * 25;
      ROWS.splice(at, 0, row(n, i % 2 ? "female" : "male", "de:berlin", i % 3));
      VECTORS.set(uuid(n), vector(n));
    }
  });

  it("plans exactly what reading every vector first planned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plan = await previewDropBatch();
    const capWarnings = warn.mock.calls.map((call) => String(call[0]));
    const literals = literalQueryIds();
    const presence = presenceQueryIds();

    vi.clearAllMocks();
    serveFixture();
    mocks.matchFindMany.mockResolvedValue([]);
    mocks.userBlockFindMany.mockResolvedValue([]);
    const reference = await referencePlan();

    expect(plan.eligible).toBe(448);
    expect(plan.missedUserIds.length).toBeGreaterThanOrEqual(32);
    expect(digest(plan)).toBe(digest(reference));
    // The same "carried to the next drop" line the reference logged.
    expect(capWarnings).toEqual(warn.mock.calls.map((call) => String(call[0])));
    expect(capWarnings).toEqual([
      expect.stringContaining(`city "ua:kyiv": 432 eligible, taking 400 — 32 carried`),
    ]);

    // Presence for every scanned row; vectors only for the 416 kept.
    expect(presence).toEqual([ROWS.map((r) => r.id)]);
    expect(literals).toHaveLength(1);
    expect(literals[0]).toHaveLength(416);
    const carried = new Set(plan.missedUserIds.slice(-32));
    expect(literals[0]!.some((id) => carried.has(id))).toBe(false);
    warn.mockRestore();
  });
});

describe("a pool under the cap", () => {
  beforeEach(() => {
    ROWS = [];
    VECTORS = new Map();
    for (let n = 1; n <= 30; n++) {
      ROWS.push(row(n, n % 3 ? "male" : "female", "ua:kyiv", n % 4));
      VECTORS.set(uuid(n), n % 7 === 0 ? null : vector(n));
    }
  });

  it("reads exactly what it always read — one vector query, no presence query", async () => {
    const plan = await previewDropBatch();

    expect(presenceQueryIds()).toEqual([]);
    expect(literalQueryIds()).toEqual([ROWS.map((r) => r.id)]);

    vi.clearAllMocks();
    serveFixture();
    mocks.matchFindMany.mockResolvedValue([]);
    mocks.userBlockFindMany.mockResolvedValue([]);
    expect(digest(plan)).toBe(digest(await referencePlan()));
  });
});

describe("runDropBatch — standby update after the drop", () => {
  beforeEach(() => {
    ROWS = [];
    VECTORS = new Map();
    // Men who all want women: nobody can be paired, everybody is missed.
    for (let n = 1; n <= 12; n++) {
      ROWS.push(row(n, "male", "ua:kyiv", n % 3));
      VECTORS.set(uuid(n), n % 4 === 0 ? null : vector(n));
    }
  });

  it("re-reads the missed users' eligibility without their vectors, same ids in the same order", async () => {
    const result = await runDropBatch();
    // The planner read the vectors once; the standby re-read only asked which
    // of the missed users have one.
    const literals = literalQueryIds();
    const presence = presenceQueryIds();
    const increment = mocks.profileUpdateMany.mock.calls
      .map(([arg]) => arg as { where: { userId: { in: string[] } }; data: Record<string, unknown> })
      .find((arg) => "lastMissedAt" in arg.data);

    // What re-reading them in full (the previous code) answered.
    const expected = (await loadEligibleUsers()).map((u) => u.id);

    expect(result.pairs).toBe(0);
    expect(result.missedUserIds).toEqual(expected);
    expect(increment?.where.userId.in).toEqual(expected);
    expect(literals).toHaveLength(1);
    expect(presence).toHaveLength(1);
    expect(presence[0]).toEqual(expected);
  });
});
