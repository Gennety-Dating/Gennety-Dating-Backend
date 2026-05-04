/**
 * Integration tests for the match-engine SQL candidate query.
 *
 * These run against a REAL PostgreSQL + pgvector database (docker-compose.test.yml).
 * They validate that the SQL in `buildCandidateSql` correctly filters candidates
 * by university, gender preference, cooldown, and open-match exclusion.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  integrationPrisma,
  cleanDatabase,
  seedUser,
  seedProfile,
} from "../../../../packages/db/src/test-integration.js";
import { buildCandidateSql, MATCH_COOLDOWN_MS } from "./match-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a fake 1536-dim embedding (all zeros except first dim). */
function fakeEmbedding(val = 0.5): string {
  const arr = new Array(1536).fill(0);
  arr[0] = val;
  return `[${arr.join(",")}]`;
}

/** Insert a user + profile with a pgvector embedding. */
async function seedFullUser(opts: {
  gender?: "male" | "female";
  preference?: "men" | "women" | "both";
  universityDomain?: string;
  embeddingVal?: number;
  lastMatchedAt?: Date | null;
}) {
  const user = await seedUser({
    gender: opts.gender ?? "male",
    preference: opts.preference ?? "women",
    universityDomain: opts.universityDomain ?? "stanford.edu",
    status: "active",
    onboardingStep: "completed",
  });

  await seedProfile({ userId: user.id });

  // Set the embedding via raw SQL (Prisma can't write Unsupported types directly)
  await integrationPrisma.$executeRawUnsafe(
    `UPDATE profiles SET embedding = $1::vector WHERE user_id = $2::uuid`,
    fakeEmbedding(opts.embeddingVal ?? 0.5),
    user.id,
  );

  if (opts.lastMatchedAt !== undefined) {
    await integrationPrisma.profile.update({
      where: { userId: user.id },
      data: { lastMatchedAt: opts.lastMatchedAt },
    });
  }

  return user;
}

/** Run the candidate SQL and return rows. */
async function queryCandidates(
  seekerId: string,
  seekerEmbedding: string,
  universityDomain: string,
  wantGender: string,
  cooldownDate: Date,
  limit = 20,
) {
  const sql = buildCandidateSql();
  return integrationPrisma.$queryRawUnsafe(
    sql,
    seekerId,
    seekerEmbedding,
    universityDomain,
    "male", // seeker's own gender — used to derive what the candidate must prefer
    wantGender, // the gender filter the seeker wants ($5)
    cooldownDate,
    limit,
  ) as Promise<Array<{ userId: string; distance: number }>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("match-engine SQL (integration)", () => {
  beforeAll(async () => {
    // Sanity: make sure pgvector extension is available
    await integrationPrisma.$executeRawUnsafe(
      "CREATE EXTENSION IF NOT EXISTS vector",
    );
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await integrationPrisma.$disconnect();
  });

  it("returns eligible candidates from the same university", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      embeddingVal: 0.5,
    });
    const candidate = await seedFullUser({
      gender: "female",
      preference: "men",
      embeddingVal: 0.6,
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(candidate.id);
  });

  it("excludes candidates from a different university", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      universityDomain: "stanford.edu",
    });
    await seedFullUser({
      gender: "female",
      preference: "men",
      universityDomain: "mit.edu",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates with incompatible gender preference", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
    });
    // Candidate prefers women, not men — should NOT match a male seeker
    await seedFullUser({
      gender: "female",
      preference: "women",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates who are still on cooldown", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
    });
    await seedFullUser({
      gender: "female",
      preference: "men",
      lastMatchedAt: new Date(), // matched right now — within cooldown
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates with an existing open match against the seeker", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
    });
    const candidate = await seedFullUser({
      gender: "female",
      preference: "men",
    });

    // Create an open match between them
    await integrationPrisma.match.create({
      data: {
        userAId: seeker.id,
        userBId: candidate.id,
        status: "proposed",
      },
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates the seeker was already matched with (completed — lifetime ban)", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    const candidate = await seedFullUser({ gender: "female", preference: "men" });

    await integrationPrisma.match.create({
      data: {
        userAId: seeker.id,
        userBId: candidate.id,
        status: "completed",
      },
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates the seeker previously cancelled on (lifetime ban)", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    const candidate = await seedFullUser({ gender: "female", preference: "men" });

    await integrationPrisma.match.create({
      data: {
        userAId: candidate.id,
        userBId: seeker.id, // reversed ordering — must still match
        status: "cancelled",
      },
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates whose prior match expired (lifetime ban covers `expired`)", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    const candidate = await seedFullUser({ gender: "female", preference: "men" });

    await integrationPrisma.match.create({
      data: {
        userAId: seeker.id,
        userBId: candidate.id,
        status: "expired",
      },
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("includes candidates with 'both' preference", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
    });
    const candidate = await seedFullUser({
      gender: "female",
      preference: "both", // should still match a male seeker
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(candidate.id);
  });

  it("orders candidates by embedding distance ASC", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      embeddingVal: 0.5,
    });

    // Close embedding
    const close = await seedFullUser({
      gender: "female",
      preference: "men",
      embeddingVal: 0.51,
    });

    // Far embedding
    const far = await seedFullUser({
      gender: "female",
      preference: "men",
      embeddingVal: 0.99,
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "stanford.edu",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(2);
    expect(rows[0]!.userId).toBe(close.id);
    expect(rows[1]!.userId).toBe(far.id);
    expect(rows[0]!.distance).toBeLessThan(rows[1]!.distance);
  });
});
