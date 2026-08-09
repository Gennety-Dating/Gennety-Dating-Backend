import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Synthetic test profiles (PRODUCT_SPEC §3.1c) — pool-admission side.
 *
 * Two guarantees are pinned here, and the first one is the money-critical of
 * the pair: a paid Rematch must never be able to sell an introduction to an
 * account that declines by construction.
 */

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  matchFindMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
    match: { findMany: mocks.matchFindMany },
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $transaction: vi.fn(),
  },
}));

import { buildCandidateSql, loadEligibleUsers, previewSyntheticFill } from "./match-engine.js";

const UUID = {
  man1: "11111111-1111-4111-8111-111111111111",
  man2: "22222222-2222-4222-8222-222222222222",
  synthA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  synthB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

/** A row shaped like the batch loader's `select`. */
function row(id: string, gender: "male" | "female") {
  return {
    id,
    age: 27,
    gender,
    major: null,
    preference: gender === "male" ? "women" : "men",
    universityDomain: null,
    profile: {
      height: gender === "male" ? 182 : 168,
      negativeConstraints: null,
      psychologicalSummary: "Calm, curious, direct.",
      energyAxis: null,
      orientationAxis: null,
      eloScore: 500,
      standbyCount: 0,
      homeCityKey: "ua:kyiv",
      ageRangeMin: null,
      ageRangeMax: null,
      typePrefTags: null,
      appearanceTags: null,
    },
  };
}

/**
 * Answer the loader by WHAT it asked for, not by call order.
 *
 * `previewSyntheticFill` fires the real and synthetic loads in a `Promise.all`,
 * and each of those runs two queries (cooldown-elapsed + never-matched), so
 * four interleaved calls arrive in no guaranteed order. Branching on the
 * `syntheticAt` filter is both order-independent and a stronger assertion: a
 * fixture can only be returned to a caller that actually asked for that side.
 *
 * Both queries of a side get the same rows; the loader dedupes by id.
 */
function stubLoader(real: Array<ReturnType<typeof row>>, synthetic: Array<ReturnType<typeof row>>) {
  mocks.userFindMany.mockImplementation(async (arg: { where: { syntheticAt?: unknown } }) =>
    arg.where.syntheticAt === null ? real : synthetic,
  );
}

/** Every id gets an embedding, and every requested pair a fixed distance. */
function stubVectors(distance = 0.4) {
  mocks.queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
    if (sql.includes("embedding::text")) {
      const ids = (params[0] as string[]) ?? [];
      return ids.map((id) => ({ user_id: id, embedding: "[0.1,0.2]" }));
    }
    // The pairwise UNION ALL splices ids straight into the SQL text.
    const pairs = [...sql.matchAll(/'([0-9a-f-]{36})' AS a_id, '([0-9a-f-]{36})' AS b_id/g)];
    return pairs.map(([, a, b]) => ({ a_id: a, b_id: b, distance }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.matchFindMany.mockResolvedValue([]);
});

describe("candidate SQL excludes synthetic profiles", () => {
  it("filters them out unconditionally", () => {
    // The single line that keeps a synthetic out of `findCandidatesFor`, and
    // therefore out of the paid Rematch and the D10 auto-resume probe. Deleting
    // it means a real user can pay 150⭐ for a partner scripted to decline.
    expect(buildCandidateSql()).toContain("u.synthetic_at IS NULL");
  });
});

describe("loadEligibleUsers — pass 1 sees real users only", () => {
  it("asks for syntheticAt: null", async () => {
    stubLoader([], []);
    await loadEligibleUsers();

    expect(mocks.userFindMany).toHaveBeenCalled();
    for (const call of mocks.userFindMany.mock.calls) {
      expect(call[0].where.syntheticAt).toBeNull();
    }
  });
});

describe("previewSyntheticFill", () => {
  it("returns nothing when no real user was left unpaired", async () => {
    const plan = await previewSyntheticFill([]);
    expect(plan.pairs).toEqual([]);
    // Not a single query: the cheap path matters because this runs on every
    // drop, including the ones where the real pool paired everybody.
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("returns nothing when no synthetic profile exists", async () => {
    stubLoader([row(UUID.man1, "male")], []);
    stubVectors();

    const plan = await previewSyntheticFill([UUID.man1]);
    expect(plan.pairs).toEqual([]);
  });

  it("pairs a leftover real man with a synthetic woman", async () => {
    stubLoader([row(UUID.man1, "male")], [row(UUID.synthA, "female")]);
    stubVectors();

    const plan = await previewSyntheticFill([UUID.man1]);

    expect(plan.pairs).toHaveLength(1);
    expect([plan.pairs[0]!.userAId, plan.pairs[0]!.userBId].sort()).toEqual(
      [UUID.man1, UUID.synthA].sort(),
    );
    expect(plan.syntheticIds.has(UUID.synthA)).toBe(true);
    expect(plan.syntheticIds.has(UUID.man1)).toBe(false);
  });

  it("never pairs two synthetic profiles with each other", async () => {
    // The fixture is built so the ONLY mutually-compatible pair in the pool is
    // synthetic↔synthetic: the real leftover is a man seeking men, which makes
    // him incompatible with both seeded profiles, while those two are
    // compatible with each other. Without the "exactly one synthetic side"
    // rule this returns a match neither participant could ever be shown — and
    // it would consume both of them for the drop.
    const gayMan = { ...row(UUID.man1, "male"), preference: "men" };
    stubLoader(
      [gayMan],
      [row(UUID.synthA, "female"), row(UUID.synthB, "male")],
    );
    stubVectors();

    const plan = await previewSyntheticFill([UUID.man1]);
    expect(plan.pairs).toEqual([]);
  });

  it("never re-offers a real pair that pass 1 already rejected", async () => {
    // Two leftovers of opposite genders: they were left unpaired by the greedy
    // allocator or a hard filter, and the fill must not overrule that.
    stubLoader([row(UUID.man1, "male"), row(UUID.man2, "female")], []);
    stubVectors();

    const plan = await previewSyntheticFill([UUID.man1, UUID.man2]);
    expect(plan.pairs).toEqual([]);
  });

  it("respects the lifetime pair ban", async () => {
    stubLoader([row(UUID.man1, "male")], [row(UUID.synthA, "female")]);
    stubVectors();
    mocks.matchFindMany.mockResolvedValue([
      { userAId: UUID.man1, userBId: UUID.synthA },
    ]);

    const plan = await previewSyntheticFill([UUID.man1]);
    // The founder chose to keep the ban as-is for synthetics too, which is why
    // N profiles buy exactly N drops per person (PRODUCT_SPEC §3.1c).
    expect(plan.pairs).toEqual([]);
  });

  it("asks for the synthetic side with syntheticAt: { not: null }", async () => {
    stubLoader([row(UUID.man1, "male")], [row(UUID.synthA, "female")]);
    stubVectors();

    await previewSyntheticFill([UUID.man1]);

    const wheres = mocks.userFindMany.mock.calls.map((c) => c[0].where.syntheticAt);
    expect(wheres.filter((w) => w === null)).toHaveLength(2);
    expect(wheres.filter((w) => w?.not === null)).toHaveLength(2);
  });
});
