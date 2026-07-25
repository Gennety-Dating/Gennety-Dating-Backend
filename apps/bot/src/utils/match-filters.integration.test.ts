/**
 * Integration tests for the shared `matches` filters.
 *
 * These MUST run against a real PostgreSQL — the bug they guard is a
 * three-valued-logic property of SQL that a mocked Prisma client cannot
 * express (a mock ignores `where` entirely, which is exactly why the
 * original `NOT: { AND: [...] }` shipped green).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  integrationPrisma,
  cleanDatabase,
  seedUser,
  seedProfile,
} from "../../../../packages/db/src/test-integration.js";
import { PAIR_NOT_BOTH_ACCEPTED } from "./match-filters.js";
import { expireStaleMatches, MATCH_TTL_MS } from "../services/match-expiry.js";

/** Seed a `proposed` match with an explicit decision state per side. */
async function seedProposal(opts: {
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  dispatchedAt?: Date;
}) {
  const userA = await seedUser({ gender: "male", preference: "women" });
  const userB = await seedUser({ gender: "female", preference: "men" });
  await seedProfile({ userId: userA.id });
  await seedProfile({ userId: userB.id });
  return integrationPrisma.match.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      status: "proposed",
      acceptedByA: opts.acceptedByA,
      acceptedByB: opts.acceptedByB,
      dispatchedAt: opts.dispatchedAt ?? new Date(),
      pitchForA: "pitch A",
      pitchForB: "pitch B",
      pitchMessageIdA: 111,
      pitchMessageIdB: 222,
    },
  });
}

describe("PAIR_NOT_BOTH_ACCEPTED (null-safe 'not both accepted')", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await integrationPrisma.$disconnect();
  });

  it("keeps a fresh proposal where both sides are still undecided", async () => {
    const match = await seedProposal({ acceptedByA: null, acceptedByB: null });

    const rows = await integrationPrisma.match.findMany({
      where: { status: "proposed", ...PAIR_NOT_BOTH_ACCEPTED },
      select: { id: true },
    });

    expect(rows.map((r) => r.id)).toEqual([match.id]);
  });

  it("keeps a half-decided pair and drops only the both-accepted pair", async () => {
    const undecided = await seedProposal({ acceptedByA: null, acceptedByB: null });
    const oneAccepted = await seedProposal({ acceptedByA: true, acceptedByB: null });
    const oneDeclined = await seedProposal({ acceptedByA: false, acceptedByB: null });
    const bothAccepted = await seedProposal({ acceptedByA: true, acceptedByB: true });

    const rows = await integrationPrisma.match.findMany({
      where: { status: "proposed", ...PAIR_NOT_BOTH_ACCEPTED },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id).sort();

    expect(ids).toEqual([undecided.id, oneAccepted.id, oneDeclined.id].sort());
    expect(ids).not.toContain(bothAccepted.id);
  });

  it("pins the two broken spellings that silently dropped undecided pairs", async () => {
    await seedProposal({ acceptedByA: null, acceptedByB: null });

    // The original bug: `NOT (a = true AND b = true)` evaluates to NULL for a
    // NULL/NULL row, which is not TRUE, so Postgres excludes it.
    const viaNotAnd = await integrationPrisma.match.count({
      where: {
        status: "proposed",
        NOT: { AND: [{ acceptedByA: true }, { acceptedByB: true }] },
      },
    });

    // The obvious-looking repair is equally broken: Prisma's `not` on a
    // nullable column does not widen to include NULL. If a future Prisma
    // release changes this, THIS assertion fails — that is the signal to
    // revisit the note in `match-filters.ts`, not to relax the filter.
    const viaNotTrue = await integrationPrisma.match.count({
      where: {
        status: "proposed",
        OR: [{ acceptedByA: { not: true } }, { acceptedByB: { not: true } }],
      },
    });

    expect(viaNotAnd).toBe(0);
    expect(viaNotTrue).toBe(0);

    // …while the shared filter sees it.
    const viaShared = await integrationPrisma.match.count({
      where: { status: "proposed", ...PAIR_NOT_BOTH_ACCEPTED },
    });
    expect(viaShared).toBe(1);
  });
});

describe("expireStaleMatches — double-silent proposals", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await integrationPrisma.$disconnect();
  });

  /**
   * The severe half of the same bug: a proposal both users ignored used to be
   * invisible to the expiry sweep, so it sat in `proposed` forever and — via
   * the single-live-match invariant — locked both users out of every future
   * weekly batch.
   */
  it("expires a proposal that BOTH sides ignored past the TTL", async () => {
    const match = await seedProposal({
      acceptedByA: null,
      acceptedByB: null,
      dispatchedAt: new Date(Date.now() - MATCH_TTL_MS - 60_000),
    });

    const result = await expireStaleMatches();

    expect(result.expired).toBe(1);
    expect(result.matches[0]?.matchId).toBe(match.id);
    expect(result.matches[0]?.sides.map((s) => s.role)).toEqual([
      "silent",
      "silent",
    ]);

    const after = await integrationPrisma.match.findUniqueOrThrow({
      where: { id: match.id },
      select: { status: true },
    });
    expect(after.status).toBe("expired");
  });

  it("leaves a still-fresh double-silent proposal alone", async () => {
    const match = await seedProposal({
      acceptedByA: null,
      acceptedByB: null,
      dispatchedAt: new Date(),
    });

    const result = await expireStaleMatches();

    expect(result.expired).toBe(0);
    const after = await integrationPrisma.match.findUniqueOrThrow({
      where: { id: match.id },
      select: { status: true },
    });
    expect(after.status).toBe("proposed");
  });

  it("still skips a pair that both accepted", async () => {
    const match = await seedProposal({
      acceptedByA: true,
      acceptedByB: true,
      dispatchedAt: new Date(Date.now() - MATCH_TTL_MS - 60_000),
    });

    const result = await expireStaleMatches();

    expect(result.expired).toBe(0);
    const after = await integrationPrisma.match.findUniqueOrThrow({
      where: { id: match.id },
      select: { status: true },
    });
    expect(after.status).toBe("proposed");
  });
});
