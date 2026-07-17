/**
 * Integration tests for the match-engine SQL candidate query.
 *
 * These run against a REAL PostgreSQL + pgvector database (docker-compose.test.yml).
 * They validate that the SQL in `buildCandidateSql` correctly filters candidates
 * by dating city, student email trust gate, gender preference, cooldown, and
 * open-match exclusion.
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
import {
  buildCandidateSql,
  createProposedMatch,
  findCandidatesFor,
  loadEligibleUsers,
  MATCH_COOLDOWN_MS,
} from "./match-engine.js";

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
  homeCityKey?: string | null;
  embeddingVal?: number;
  lastMatchedAt?: Date | null;
  verificationStatus?:
    | "unverified"
    | "pending"
    | "pending_review"
    | "verified"
    | "rejected";
  verificationSkippedAt?: Date | null;
  // Registration v2 contact rails (default: email-verified legacy user).
  isEmailVerified?: boolean;
  phoneVerifiedAt?: Date | null;
  registrationTrack?: "student" | "general" | null;
}) {
  const user = await seedUser({
    gender: opts.gender ?? "male",
    preference: opts.preference ?? "women",
    universityDomain: opts.universityDomain ?? "stanford.edu",
    status: "active",
    onboardingStep: "completed",
    // Spread-conditionally: under exactOptionalPropertyTypes, passing
    // `verificationStatus: undefined` is a type error. Only forward when set.
    verificationStatus: opts.verificationStatus ?? "verified",
    ...(opts.verificationSkippedAt !== undefined
      ? { verificationSkippedAt: opts.verificationSkippedAt }
      : {}),
    ...(opts.isEmailVerified !== undefined
      ? { isEmailVerified: opts.isEmailVerified }
      : {}),
    ...(opts.phoneVerifiedAt !== undefined
      ? { phoneVerifiedAt: opts.phoneVerifiedAt }
      : {}),
    ...(opts.registrationTrack !== undefined
      ? { registrationTrack: opts.registrationTrack }
      : {}),
  });

  await seedProfile({ userId: user.id });
  await integrationPrisma.profile.update({
    where: { userId: user.id },
    data: {
      homeCity: opts.homeCityKey === null ? null : "Kyiv",
      homeCountryCode: opts.homeCityKey === null ? null : "UA",
      homeCityKey: opts.homeCityKey === undefined ? "ua:kyiv" : opts.homeCityKey,
      latitude: opts.homeCityKey === null ? null : 50.4501,
      longitude: opts.homeCityKey === null ? null : 30.5234,
      locationUpdatedAt: opts.homeCityKey === null ? null : new Date(),
    },
  });

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
  homeCityKey: string,
  wantGender: string,
  cooldownDate: Date,
  limit = 20,
) {
  const sql = buildCandidateSql();
  return integrationPrisma.$queryRawUnsafe(
    sql,
    seekerId,
    seekerEmbedding,
    homeCityKey,
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

  it("returns eligible candidates from the same dating city", async () => {
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
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(candidate.id);
  });

  it("admits a phone-only (general track) candidate — union contact rail", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      embeddingVal: 0.5,
    });
    const phoneOnly = await seedFullUser({
      gender: "female",
      preference: "men",
      isEmailVerified: false,
      phoneVerifiedAt: new Date(),
      registrationTrack: "general",
      embeddingVal: 0.6,
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(phoneOnly.id);
  });

  it("does not let a student-track candidate substitute a phone for university email", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    await seedFullUser({
      gender: "female",
      preference: "men",
      registrationTrack: "student",
      isEmailVerified: false,
      phoneVerifiedAt: new Date(),
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );
    expect(rows).toHaveLength(0);
  });

  it("does not let a general-track candidate substitute email for a trusted phone", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    await seedFullUser({
      gender: "female",
      preference: "men",
      registrationTrack: "general",
      isEmailVerified: true,
      phoneVerifiedAt: null,
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects a general-track seeker that only has verified email", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      registrationTrack: "general",
      isEmailVerified: true,
      phoneVerifiedAt: null,
    });
    await seedFullUser({ gender: "female", preference: "men" });

    await expect(findCandidatesFor(seeker.id)).resolves.toEqual([]);
  });

  it("keeps a valid legacy email-verified seeker eligible", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    const candidate = await seedFullUser({ gender: "female", preference: "men" });

    const results = await findCandidatesFor(seeker.id);
    expect(results.map((result) => result.userId)).toContain(candidate.id);
  });

  it("applies the same track-aware predicate to batch eligibility", async () => {
    const validLegacy = await seedFullUser({ gender: "male", preference: "women" });
    const validGeneral = await seedFullUser({
      gender: "female",
      preference: "men",
      registrationTrack: "general",
      isEmailVerified: false,
      phoneVerifiedAt: new Date(),
    });
    const invalidGeneral = await seedFullUser({
      gender: "female",
      preference: "men",
      registrationTrack: "general",
      isEmailVerified: true,
      phoneVerifiedAt: null,
    });

    const eligible = await loadEligibleUsers();
    const ids = eligible.map((user) => user.id);
    expect(ids).toContain(validLegacy.id);
    expect(ids).toContain(validGeneral.id);
    expect(ids).not.toContain(invalidGeneral.id);
  });

  it("excludes a candidate with neither verified rail (no email, no phone)", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      embeddingVal: 0.5,
    });
    await seedFullUser({
      gender: "female",
      preference: "men",
      isEmailVerified: false,
      phoneVerifiedAt: null,
      embeddingVal: 0.6,
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("allows candidates from a different university in the same dating city", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      universityDomain: "stanford.edu",
    });
    const candidate = await seedFullUser({
      gender: "female",
      preference: "men",
      universityDomain: "mit.edu",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(candidate.id);
  });

  it("excludes candidates from a different dating city even at the same university", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      universityDomain: "stanford.edu",
      homeCityKey: "ua:kyiv",
    });
    await seedFullUser({
      gender: "female",
      preference: "men",
      universityDomain: "stanford.edu",
      homeCityKey: "ua:lviv",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates missing a dating city", async () => {
    const seeker = await seedFullUser({
      gender: "male",
      preference: "women",
      homeCityKey: "ua:kyiv",
    });
    await seedFullUser({
      gender: "female",
      preference: "men",
      homeCityKey: null,
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
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
      "ua:kyiv",
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
      "ua:kyiv",
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
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes a candidate who has an open match with a different user", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    const candidate = await seedFullUser({ gender: "female", preference: "men" });
    const other = await seedFullUser({ gender: "male", preference: "women" });
    await integrationPrisma.match.create({
      data: { userAId: other.id, userBId: candidate.id, status: "scheduled" },
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows).toEqual([]);
  });

  it("serializes competing allocations so a user receives only one live match", async () => {
    const shared = await seedFullUser({ gender: "male", preference: "women" });
    const first = await seedFullUser({ gender: "female", preference: "men" });
    const second = await seedFullUser({ gender: "female", preference: "men" });

    const results = await Promise.all([
      createProposedMatch(shared.id, first.id),
      createProposedMatch(shared.id, second.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const active = await integrationPrisma.match.findMany({
      where: {
        status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
        OR: [{ userAId: shared.id }, { userBId: shared.id }],
      },
    });
    expect(active).toHaveLength(1);
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
      "ua:kyiv",
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
      "ua:kyiv",
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
      "ua:kyiv",
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
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(candidate.id);
  });

  it("excludes candidates with verificationStatus = rejected", async () => {
    // Re-verification can flip a previously-active user to `rejected`
    // without touching their `status`. Without the verification gate the
    // SQL would still hand them out as a match.
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    await seedFullUser({
      gender: "female",
      preference: "men",
      verificationStatus: "rejected",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("excludes candidates with verificationStatus = pending_review", async () => {
    // pending_review = admin moderation queue; the user shouldn't surface
    // as a candidate until ops resolves their case.
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    await seedFullUser({
      gender: "female",
      preference: "men",
      verificationStatus: "pending_review",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(0);
  });

  it("includes verified and explicit legacy skippers, but excludes new unverified/pending users", async () => {
    const seeker = await seedFullUser({ gender: "male", preference: "women" });
    const verified = await seedFullUser({
      gender: "female",
      preference: "men",
      verificationStatus: "verified",
    });
    const grandfathered = await seedFullUser({
      gender: "female",
      preference: "men",
      verificationStatus: "unverified",
      verificationSkippedAt: new Date("2026-05-08T20:00:00Z"),
    });
    await seedFullUser({
      gender: "female",
      preference: "men",
      verificationStatus: "unverified",
    });
    const pending = await seedFullUser({
      gender: "female",
      preference: "men",
      verificationStatus: "pending",
    });

    const rows = await queryCandidates(
      seeker.id,
      fakeEmbedding(0.5),
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    const ids = rows.map((r) => r.userId).sort();
    expect(ids).toEqual([verified.id, grandfathered.id].sort());
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
      "ua:kyiv",
      "female",
      new Date(Date.now() - MATCH_COOLDOWN_MS),
    );

    expect(rows.length).toBe(2);
    expect(rows[0]!.userId).toBe(close.id);
    expect(rows[1]!.userId).toBe(far.id);
    expect(rows[0]!.distance).toBeLessThan(rows[1]!.distance);
  });
});
