import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The drop batch's planners hand the event loop back while they score pairs,
 * the same way `computePairwiseDistances` already did. Where a loop pauses
 * must not change what it plans, so both planners are pinned end to end —
 * eligible count, every planned pair with its score, breakdown and
 * fingerprints, the greedy order and the missed list — against a digest
 * recorded from the engine before the scoring loop yielded, once with real
 * time and once with a clock that forces a yield at every check.
 */

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  matchFindMany: vi.fn(),
  userBlockFindMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
    match: { findMany: mocks.matchFindMany },
    userBlock: { findMany: mocks.userBlockFindMany },
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $transaction: vi.fn(),
  },
}));

import { previewDropBatch, previewSyntheticFill } from "./match-engine.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const SUMMARY_WORDS = ["calm", "smoker", "non-smoker", "late nights", "gym", "кава", "jazz", "lazy", "runner"];
const TRAITS = ["smoker", "late nights", "кава", "lazy", "c++"];
const MAJORS = ["Computer Science", "History", "Fine Arts", "Medicine", "CS", null];

interface FixtureRow {
  id: string;
  age: number;
  gender: "male" | "female";
  major: string | null;
  preference: "men" | "women" | "both";
  universityDomain: string | null;
  profile: {
    height: number;
    negativeConstraints: string | null;
    psychologicalSummary: string;
    energyAxis: number | null;
    orientationAxis: number | null;
    eloScore: number;
    standbyCount: number;
    homeCityKey: string;
    ageRangeMin: number | null;
    ageRangeMax: number | null;
    typePrefTags: null;
    appearanceTags: null;
    relationshipIntents: string[];
  };
}

function fixture(count: number, offset: number, seed: number): { rows: FixtureRow[]; vectors: Map<string, string | null> } {
  const rand = lcg(seed);
  const rows: FixtureRow[] = [];
  const vectors = new Map<string, string | null>();
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  for (let i = 0; i < count; i++) {
    const id = uuid(offset + i);
    const traits = rand() < 0.5 ? null : `- [lifestyle] avoid [${pick(TRAITS)}, ${pick(TRAITS)}]\n- ${pick(TRAITS)}`;
    rows.push({
      id,
      age: 18 + Math.floor(rand() * 12),
      gender: rand() < 0.5 ? "male" : "female",
      major: pick(MAJORS),
      preference: pick(["men", "women", "both"] as const),
      universityDomain: "knu.ua",
      profile: {
        height: 155 + Math.floor(rand() * 40),
        negativeConstraints: traits,
        psychologicalSummary: Array.from({ length: 12 }, () => pick(SUMMARY_WORDS)).join(" "),
        energyAxis: rand() < 0.2 ? null : rand() * 2 - 1,
        orientationAxis: rand() < 0.2 ? null : rand() * 2 - 1,
        eloScore: 300 + Math.floor(rand() * 400),
        standbyCount: Math.floor(rand() * 4),
        homeCityKey: rand() < 0.75 ? "ua:kyiv" : "de:berlin",
        ageRangeMin: rand() < 0.3 ? 20 : null,
        ageRangeMax: rand() < 0.3 ? 26 : null,
        typePrefTags: null,
        appearanceTags: null,
        relationshipIntents: [],
      },
    });
    const roll = rand();
    vectors.set(
      id,
      roll < 0.05
        ? null
        : roll < 0.08
          ? "[0,0,0,0,0,0]"
          : `[${Array.from({ length: 6 }, () => (rand() * 2 - 1).toFixed(4)).join(",")}]`,
    );
  }
  return { rows, vectors };
}

const REAL = fixture(90, 1, 99);
const SYNTHETIC = fixture(12, 1000, 7);
const VECTORS = new Map([...REAL.vectors, ...SYNTHETIC.vectors]);

beforeEach(() => {
  mocks.userFindMany.mockImplementation(
    async (arg: { where: { syntheticAt?: unknown; id?: { in: string[] }; profile: { lastMatchedAt: unknown } } }) => {
      // The cooldown scan gets every row, the never-matched scan none — the
      // loader dedupes, so one scan carrying the pool is the whole pool.
      if (arg.where.profile.lastMatchedAt === null) return [];
      const side = arg.where.syntheticAt === null ? REAL.rows : SYNTHETIC.rows;
      const wanted = arg.where.id?.in;
      return wanted ? side.filter((row) => wanted.includes(row.id)) : side;
    },
  );
  mocks.queryRawUnsafe.mockImplementation(async (sql: string, ids: string[]) => {
    expect(sql).toContain("embedding::text");
    return ids.map((id) => ({ user_id: id, embedding: VECTORS.get(id) ?? null }));
  });
  // A lifetime ban and a block, so the exclusion set is exercised.
  mocks.matchFindMany.mockResolvedValue([
    { userAId: REAL.rows[0]!.id, userBId: REAL.rows[1]!.id },
    { userAId: REAL.rows[4]!.id, userBId: REAL.rows[7]!.id },
  ]);
  mocks.userBlockFindMany.mockResolvedValue([
    { blockerId: REAL.rows[2]!.id, blockedId: REAL.rows[3]!.id },
    { blockerId: REAL.rows[5]!.id, blockedId: null },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A clock that has always run past the slice, so every check yields. */
function forceYieldAtEveryCheck() {
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 30));
  return vi.spyOn(globalThis, "setImmediate");
}

describe("drop batch planners — yielding changes no plan", () => {
  it("previewDropBatch matches the pre-yield digest", async () => {
    const plan = await previewDropBatch();
    expect(plan.eligible).toBe(PINNED.drop.eligible);
    expect(plan.pairs).toBe(PINNED.drop.pairs);
    expect(digest(plan)).toBe(PINNED.drop.digest);
  });

  it("previewDropBatch yields between pairs and still matches the digest", async () => {
    const setImmediateSpy = forceYieldAtEveryCheck();
    const plan = await previewDropBatch();
    expect(setImmediateSpy.mock.calls.length).toBeGreaterThan(PINNED.drop.pairs);
    expect(digest(plan)).toBe(PINNED.drop.digest);
  });

  it("previewSyntheticFill matches the pre-yield digest, with and without forced yields", async () => {
    const missed = REAL.rows.slice(0, 40).map((row) => row.id);
    const plan = await previewSyntheticFill(missed);
    const serialised = { pairs: plan.pairs, syntheticIds: [...plan.syntheticIds] };
    expect(plan.pairs.length).toBe(PINNED.fill.pairs);
    expect(digest(serialised)).toBe(PINNED.fill.digest);

    const setImmediateSpy = forceYieldAtEveryCheck();
    const yielded = await previewSyntheticFill(missed);
    expect(setImmediateSpy).toHaveBeenCalled();
    expect(digest({ pairs: yielded.pairs, syntheticIds: [...yielded.syntheticIds] })).toBe(
      PINNED.fill.digest,
    );
  });
});

// Recorded from match-engine.ts at 5d935472, before the scoring loop yielded.
const PINNED = {
  drop: { eligible: 86, pairs: 38, digest: "9e882345c99d61cf2910971fc4ad93d271eb43f49ca9b9d027110091fa7df487" },
  fill: { pairs: 11, digest: "cabef95a775f86ab3f32493d992e8de39b1f8dd6c2997ce547e4383f3ff89c94" },
};
