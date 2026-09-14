/**
 * Account deletion against a REAL Postgres (A13-H14, A13-H13).
 *
 * The unit tests pin the calls; only a database can show what a cascade, a
 * `SET NULL` foreign key or a raw statement actually does. Every defect these
 * cases guard against lived there: ledgers and reports cascading away with the
 * user, a relinked block colliding with the `(blocker_id, blocked_id)` unique,
 * and a Scratch Map upsert Postgres refused to parse.
 *
 * Prerequisites (same as every integration file):
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tombstones are keyed by a key derived from JWT_SECRET, and are neither
// written nor looked up without one. Set before `config.ts` is imported.
vi.hoisted(() => {
  process.env.JWT_SECRET ??= "integration-safety-tombstone-secret";
});

import {
  cleanDatabase,
  integrationPrisma as db,
  seedUser,
} from "../../../../packages/db/src/test-integration.js";
import { AccountDeletionDeferredError, deleteUserAccount } from "./account-deletion.js";
import { restoreSafetyHistory } from "./safety-tombstone.js";
import { recordVerifiedVisit } from "./scratch-map.js";
import { isPairBlocked, loadBlockedPairKeys } from "./user-block.js";
import { retentionTick } from "../workers/retention.js";

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

async function seedDeletionScene() {
  const reporter = await seedUser({ firstName: "Reporter" });
  const blocker = await seedUser({ firstName: "Blocker", gender: "female", preference: "men" });
  const leaving = await seedUser({
    firstName: "Leaving",
    telegramId: 900_003n,
    status: "active",
    phoneVerifiedAt: new Date("2026-08-01T00:00:00Z"),
  });
  await db.user.update({
    where: { id: leaving.id },
    data: { status: "banned", strikes: 3, phone: "+380501112233" },
  });
  const match = await db.match.create({
    data: { userAId: reporter.id, userBId: leaving.id, status: "completed" },
  });
  const report = await db.report.create({
    data: {
      reporterId: reporter.id,
      reportedId: leaving.id,
      matchId: match.id,
      rawText: "was aggressive at the venue",
      tier: 2,
    },
  });
  const blockAgainst = await db.userBlock.create({
    data: { blockerId: blocker.id, blockedId: leaving.id },
  });
  const blockDrawn = await db.userBlock.create({
    data: { blockerId: leaving.id, blockedId: blocker.id },
  });
  const ledger = await db.ticketLedger.create({
    data: {
      userId: leaving.id,
      delta: 3,
      reason: "store_purchase",
      bundleSize: 3,
      amountStars: 1275,
      externalPaymentId: "tg-charge-ledger",
    },
  });
  const purchase = await db.rematchPurchase.create({
    data: {
      userId: leaving.id,
      status: "settled",
      externalPaymentId: "tg-charge-rematch",
      amountStars: 250,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  });
  return { reporter, blocker, leaving, match, report, blockAgainst, blockDrawn, ledger, purchase };
}

describe("deleteUserAccount — what outlives the account", () => {
  it("keeps payment rows and the reports/blocks against the account, and drops the rest", async () => {
    const scene = await seedDeletionScene();

    const result = await deleteUserAccount(scene.leaving.id, null);

    expect(result.deleted).toBe(true);
    expect(await db.user.findUnique({ where: { id: scene.leaving.id } })).toBeNull();

    // Payments: kept, owner nulled.
    expect(await db.ticketLedger.findUnique({ where: { id: scene.ledger.id } })).toMatchObject({
      userId: null,
      amountStars: 1275,
    });
    expect(await db.rematchPurchase.findUnique({ where: { id: scene.purchase.id } })).toMatchObject({
      userId: null,
      status: "settled",
    });

    // The report against them: kept, stamped, its match gone with the account.
    expect(await db.report.findUnique({ where: { id: scene.report.id } })).toMatchObject({
      reporterId: scene.reporter.id,
      reportedId: null,
      matchId: null,
      reportedFormerId: scene.leaving.id,
    });

    // The block against them survives; the one they drew is their own data.
    expect(await db.userBlock.findUnique({ where: { id: scene.blockAgainst.id } })).toMatchObject({
      blockerId: scene.blocker.id,
      blockedId: null,
      blockedFormerId: scene.leaving.id,
    });
    expect(await db.userBlock.findUnique({ where: { id: scene.blockDrawn.id } })).toBeNull();

    // One tombstone per proven identity, nothing in the clear.
    const tombstones = await db.safetyTombstone.findMany({ orderBy: { kind: "asc" } });
    expect(tombstones.map((row) => row.kind)).toEqual(["email", "phone", "telegram"]);
    for (const row of tombstones) {
      expect(row).toMatchObject({ formerUserId: scene.leaving.id, status: "banned", strikes: 3 });
      expect(row.identityHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("defers while a refund is in flight and leaves everything in place", async () => {
    const scene = await seedDeletionScene();
    await db.rematchPurchase.update({
      where: { id: scene.purchase.id },
      data: { status: "refund_failed", createdAt: new Date() },
    });

    await expect(deleteUserAccount(scene.leaving.id, null)).rejects.toBeInstanceOf(
      AccountDeletionDeferredError,
    );
    expect(await db.user.findUnique({ where: { id: scene.leaving.id } })).not.toBeNull();
    expect(await db.safetyTombstone.count()).toBe(0);
    expect(await db.report.findUnique({ where: { id: scene.report.id } })).toMatchObject({
      reportedId: scene.leaving.id,
      reportedFormerId: null,
    });
  });
});

describe("restoreSafetyHistory — the same person comes back", () => {
  it("restores the ban and strikes, relinks the report and the block, and does it once", async () => {
    const scene = await seedDeletionScene();
    await deleteUserAccount(scene.leaving.id, null);

    // The blocker had ALSO blocked a second former account of the same person:
    // relinking both would collide on (blocker_id, blocked_id).
    const secondFormer = "44444444-4444-4444-8444-444444444444";
    await db.userBlock.create({
      data: { blockerId: scene.blocker.id, blockedId: null, blockedFormerId: secondFormer },
    });
    await db.safetyTombstone.create({
      data: {
        identityHash: (await db.safetyTombstone.findFirstOrThrow({ where: { kind: "telegram" } })).identityHash,
        kind: "telegram",
        formerUserId: secondFormer,
        status: null,
        strikes: 1,
      },
    });

    const returning = await db.user.create({
      data: { telegramId: 900_003n, firstName: null, platform: "telegram" },
    });

    // Before the relink, the block excludes nobody.
    expect(await isPairBlocked(scene.blocker.id, returning.id)).toBe(false);

    const result = await restoreSafetyHistory(returning.id);

    expect(result).toMatchObject({
      applied: true,
      statusRestored: "banned",
      strikesRestored: 3,
      reportsRelinked: 1,
      blocksRelinked: 1,
    });
    expect(await db.user.findUniqueOrThrow({ where: { id: returning.id } })).toMatchObject({
      status: "banned",
      strikes: 3,
    });
    expect(await db.report.findUniqueOrThrow({ where: { id: scene.report.id } })).toMatchObject({
      reportedId: returning.id,
      reportedFormerId: null,
    });
    expect(await db.userBlock.count({ where: { blockerId: scene.blocker.id } })).toBe(1);
    expect(await isPairBlocked(scene.blocker.id, returning.id)).toBe(true);
    const keys = await loadBlockedPairKeys([scene.blocker.id, returning.id]);
    expect(keys.has(`${returning.id}:${scene.blocker.id}`)).toBe(true);

    // Idempotent: nothing left to apply to this account.
    await expect(restoreSafetyHistory(returning.id)).resolves.toMatchObject({ applied: false });
    const tombstones = await db.safetyTombstone.findMany();
    expect(tombstones.every((row) => row.restoredToUserId === returning.id)).toBe(true);
  });

  it("ages tombstones out, and with them the reports and blocks nothing can relink any more", async () => {
    const scene = await seedDeletionScene();
    await deleteUserAccount(scene.leaving.id, null);
    await db.safetyTombstone.updateMany({ data: { createdAt: new Date("2024-01-01T00:00:00Z") } });

    const result = await retentionTick(new Date("2026-09-14T00:00:00Z"));

    expect(result.safetyTombstones).toBe(3);
    expect(result.orphanReports).toBe(1);
    expect(result.orphanBlocks).toBe(1);
    expect(await db.report.findUnique({ where: { id: scene.report.id } })).toBeNull();
    expect(await db.userBlock.findUnique({ where: { id: scene.blockAgainst.id } })).toBeNull();
    // Payment rows are not the retention sweep's to touch.
    expect(await db.ticketLedger.findUnique({ where: { id: scene.ledger.id } })).not.toBeNull();
  });
});

describe("Scratch Map merge — the statement Postgres used to refuse (A13-H13)", () => {
  it("inserts, then merges a second writer's tiles and venue into the same row", async () => {
    const user = await seedUser();
    await db.user.update({ where: { id: user.id }, data: { scratchMapOptIn: true } });

    // Kyiv centre, then a point in Podil — two different tiles.
    await recordVerifiedVisit({ userIds: [user.id], venueId: "venue-1", lat: 50.4501, lng: 30.5234 });
    await recordVerifiedVisit({ userIds: [user.id], venueId: "venue-2", lat: 50.4645, lng: 30.5164 });

    const row = await db.userScratchMap.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.exploredTiles).toHaveLength(2);
    expect(row.discoveredVenues).toEqual(["venue-1", "venue-2"]);
    expect(row.exploredPercent).toBeGreaterThan(0);
  });
});
