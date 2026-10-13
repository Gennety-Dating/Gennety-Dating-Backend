/**
 * The dead-match refund sweep against a real PostgreSQL: its SQL (two raw
 * joins) and its exactly-once guarantee are the point, and a mocked client can
 * express neither.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Api, RawApi } from "grammy";
import {
  integrationPrisma,
  cleanDatabase,
  seedUser,
} from "../../../../packages/db/src/test-integration.js";

const founder = vi.hoisted(() => ({
  recovered: vi.fn(async (_input: unknown) => {}),
  orphan: vi.fn(async (_input: unknown) => true),
}));
vi.mock("./founder-notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./founder-notify.js")>()),
  notifyFounderDeadMatchRefundRecovered: founder.recovered,
  notifyFounderOrphanedPassReview: founder.orphan,
}));

const { sweepDeadMatchRefunds } = await import("./dead-match-refund-sweep.js");
const { applyTicketRefundsInTx, matchRefundKey } = await import("./ticket-refund.js");

const MINUTE = 60 * 1000;

function fakeApi() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    refundStarPayment: vi.fn(async () => true),
  };
}

/** A cancelled match both sides paid for from their wallets, `minutesAgo` old. */
async function seedCancelledPaidMatch(minutesAgo: number) {
  const userA = await seedUser({ gender: "male", preference: "women" });
  const userB = await seedUser({ gender: "female", preference: "men" });
  const paidAt = new Date(Date.now() - 2 * 24 * 60 * MINUTE);
  const match = await integrationPrisma.match.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      status: "cancelled",
      acceptedByA: true,
      acceptedByB: true,
      ticketStatus: "paid",
      ticketPaidA: paidAt,
      ticketPaidB: paidAt,
    },
  });
  await integrationPrisma.ticketLedger.createMany({
    data: [
      { userId: userA.id, delta: -1, reason: "spend_match", matchId: match.id },
      { userId: userB.id, delta: -1, reason: "spend_match", matchId: match.id },
    ],
  });
  // `updatedAt` is stamped by Prisma; age the row past (or inside) the grace.
  await integrationPrisma.$executeRaw`
    UPDATE matches SET updated_at = ${new Date(Date.now() - minutesAgo * MINUTE)}
    WHERE id = ${match.id}::uuid`;
  return { match, userA, userB };
}

async function balance(userId: string): Promise<number> {
  const row = await integrationPrisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { ticketBalance: true },
  });
  return row.ticketBalance;
}

describe("dead-match refund sweep", () => {
  beforeEach(async () => {
    await cleanDatabase();
    founder.recovered.mockClear();
    founder.orphan.mockClear().mockResolvedValue(true);
  });

  afterAll(async () => {
    await integrationPrisma.$disconnect();
  });

  it("pays a cancellation whose refund never ran — once, however often it runs", async () => {
    const { match, userA, userB } = await seedCancelledPaidMatch(60);
    const api = fakeApi();

    const first = await sweepDeadMatchRefunds(api as unknown as Api<RawApi>);
    const second = await sweepDeadMatchRefunds(api as unknown as Api<RawApi>);

    expect(first.ticketsRecovered).toBe(2);
    expect(second.ticketsRecovered).toBe(0);
    expect(await balance(userA.id)).toBe(1);
    expect(await balance(userB.id)).toBe(1);
    // The same keys as the live rail — a late live refund cannot pay twice.
    const keys = await integrationPrisma.ticketLedger.findMany({
      where: { matchId: match.id, reason: "refund" },
      select: { externalPaymentId: true },
    });
    expect(keys.map((k) => k.externalPaymentId).sort()).toEqual(
      [matchRefundKey(match.id, userA.id, "A"), matchRefundKey(match.id, userB.id, "B")].sort(),
    );
    // Both payers told, the founder told once.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(founder.recovered).toHaveBeenCalledOnce();
  });

  it("leaves alone a match the live rail already refunded", async () => {
    const { match, userA, userB } = await seedCancelledPaidMatch(60);
    await integrationPrisma.ticketLedger.createMany({
      data: [
        { userId: userA.id, delta: 1, reason: "refund", matchId: match.id, externalPaymentId: matchRefundKey(match.id, userA.id, "A") },
        { userId: userB.id, delta: 1, reason: "refund", matchId: match.id, externalPaymentId: matchRefundKey(match.id, userB.id, "B") },
      ],
    });

    const res = await sweepDeadMatchRefunds(fakeApi() as unknown as Api<RawApi>);

    expect(res.ticketMatchesScanned).toBe(1);
    expect(res.ticketsRecovered).toBe(0);
    expect(founder.recovered).not.toHaveBeenCalled();
  });

  it("finishes only the slot a half-done refund left behind", async () => {
    const { match, userA, userB } = await seedCancelledPaidMatch(60);
    await integrationPrisma.ticketLedger.create({
      data: { userId: userA.id, delta: 1, reason: "refund", matchId: match.id, externalPaymentId: matchRefundKey(match.id, userA.id, "A") },
    });

    const res = await sweepDeadMatchRefunds(fakeApi() as unknown as Api<RawApi>);

    expect(res.ticketsRecovered).toBe(1);
    expect(await balance(userA.id)).toBe(0);
    expect(await balance(userB.id)).toBe(1);
  });

  it("does not touch a cancellation still inside the live rail's grace", async () => {
    const { userA } = await seedCancelledPaidMatch(1);

    const res = await sweepDeadMatchRefunds(fakeApi() as unknown as Api<RawApi>);

    expect(res.ticketMatchesScanned).toBe(0);
    expect(await balance(userA.id)).toBe(0);
  });

  it("returns a Prime Time pass still settled on a cancelled match", async () => {
    const { match, userA } = await seedCancelledPaidMatch(60);
    const pass = await integrationPrisma.primeTimePurchase.create({
      data: {
        userId: userA.id,
        matchId: match.id,
        status: "settled",
        externalPaymentId: `stars-${randomUUID()}`,
        amountStars: 50,
      },
    });
    const api = fakeApi();

    const res = await sweepDeadMatchRefunds(api as unknown as Api<RawApi>);

    expect(res.passMatchesRecovered).toBe(1);
    expect(api.refundStarPayment).toHaveBeenCalledWith(Number(userA.telegramId), pass.externalPaymentId);
    const row = await integrationPrisma.primeTimePurchase.findUniqueOrThrow({ where: { id: pass.id } });
    expect(row.status).toBe("refunded_match_died");
    expect(founder.recovered).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: match.id, primeTimePasses: 1 }),
    );
  });

  it("sends a pass whose match was erased to the founder — a tick after first seeing it, once", async () => {
    const payer = await seedUser();
    const pass = await integrationPrisma.primeTimePurchase.create({
      data: {
        userId: payer.id,
        matchId: randomUUID(), // erased with a deleted account
        status: "settled",
        externalPaymentId: `stars-${randomUUID()}`,
        amountStars: 50,
      },
    });
    const api = fakeApi() as unknown as Api<RawApi>;
    const now = new Date();

    await sweepDeadMatchRefunds(api, now);
    expect(founder.orphan).not.toHaveBeenCalled();

    const later = new Date(now.getTime() + 60 * MINUTE);
    const res = await sweepDeadMatchRefunds(api, later);
    await sweepDeadMatchRefunds(api, new Date(later.getTime() + 60 * MINUTE));

    expect(res.orphanedPassesReported).toBe(1);
    expect(founder.orphan).toHaveBeenCalledOnce();
    expect(founder.orphan).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseId: pass.id, appStore: false }),
    );
    // Not refunded: the founder decides.
    const row = await integrationPrisma.primeTimePurchase.findUniqueOrThrow({ where: { id: pass.id } });
    expect(row.status).toBe("settled");
  });

  it("keeps offering an orphaned pass while the founder feed cannot deliver it", async () => {
    await integrationPrisma.primeTimePurchase.create({
      data: {
        userId: (await seedUser()).id,
        matchId: randomUUID(),
        status: "settled",
        externalPaymentId: `stars-${randomUUID()}`,
        amountStars: 50,
      },
    });
    founder.orphan.mockResolvedValue(false);
    const api = fakeApi() as unknown as Api<RawApi>;
    const now = Date.now();

    await sweepDeadMatchRefunds(api, new Date(now));
    await sweepDeadMatchRefunds(api, new Date(now + 60 * MINUTE));
    await sweepDeadMatchRefunds(api, new Date(now + 120 * MINUTE));

    expect(founder.orphan).toHaveBeenCalledTimes(2);
  });
});

describe("ticket refund inside the caller's transaction", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("credits once, and a repeat inside another transaction neither credits nor aborts it", async () => {
    const { match, userB } = await seedCancelledPaidMatch(60);
    const credit = {
      matchId: match.id,
      userId: userB.id,
      slots: ["B" as const],
      telegramId: userB.telegramId,
      language: "en" as const,
      platform: "telegram",
    };

    const first = await integrationPrisma.$transaction((tx) => applyTicketRefundsInTx(tx, [credit]));
    const second = await integrationPrisma.$transaction(async (tx) => {
      const outcomes = await applyTicketRefundsInTx(tx, [credit]);
      // A later statement in the same transaction still runs: the duplicate
      // key did not abort it (an INSERT that raised would have).
      await tx.user.update({ where: { id: userB.id }, data: { firstName: "still-alive" } });
      return outcomes;
    });

    expect(first[0]?.refunded).toBe(1);
    expect(second[0]?.refunded).toBe(0);
    expect(await balance(userB.id)).toBe(1);
    const user = await integrationPrisma.user.findUniqueOrThrow({ where: { id: userB.id } });
    expect(user.firstName).toBe("still-alive");
  });
});
