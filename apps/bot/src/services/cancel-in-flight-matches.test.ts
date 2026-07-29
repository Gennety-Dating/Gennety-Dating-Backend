import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: vi.fn(),
      // Read by the ticket-refund planner. Defaults to an unpaid gate, so the
      // cancellation assertions below stay about cancellation.
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ticketLedger: { create: vi.fn() },
    // `grantTickets` uses the array form.
    $transaction: vi.fn(),
  },
}));

vi.mock("./push.js", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../utils/elo-calculator.js", () => ({
  applyEmergencyCancellationPeerBoost: vi.fn().mockResolvedValue(505),
}));

import { prisma } from "@gennety/db";
import { applyEmergencyCancellationPeerBoost } from "../utils/elo-calculator.js";
import { sendPushToUser } from "./push.js";
import {
  cancelInFlightMatchesForUser,
  IN_FLIGHT_MATCH_STATUSES,
} from "./cancel-in-flight-matches.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findMany: MockFn;
  findUnique: MockFn;
  updateMany: MockFn;
};
const mUser = prisma.user as unknown as { findUnique: MockFn; update: MockFn };
const mLedger = prisma.ticketLedger as unknown as { create: MockFn };
const mTx = prisma.$transaction as unknown as MockFn;
const mComp = applyEmergencyCancellationPeerBoost as unknown as MockFn;
const mPush = sendPushToUser as unknown as MockFn;

const LEAVING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARTNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** An unpaid ticket gate — nothing to refund. */
const UNPAID = {
  ticketStatus: "pending",
  ticketPaidA: null,
  ticketPaidB: null,
  paidForPartnerByA: false,
  paidForPartnerByB: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mMatch.updateMany.mockResolvedValue({ count: 1 });
  mMatch.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    ...UNPAID,
    userAId: LEAVING,
    userBId: PARTNER,
    userA: { telegramId: 100n, language: "en", platform: "telegram" },
    userB: { telegramId: 200n, language: "en", platform: "telegram" },
  }));
  mUser.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
  }));
  mUser.update.mockResolvedValue({ ticketBalance: 1 });
  mLedger.create.mockResolvedValue({});
  // `grantTickets` passes an array of promises; awaiting them runs the mocks.
  mTx.mockImplementation(async (ops: unknown) => Promise.all(ops as Promise<unknown>[]));
});

describe("cancelInFlightMatchesForUser", () => {
  it("queries ALL four in-flight statuses (not just proposed/negotiating)", async () => {
    mMatch.findMany.mockResolvedValueOnce([]);
    await cancelInFlightMatchesForUser(LEAVING, null);

    const where = mMatch.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual([...IN_FLIGHT_MATCH_STATUSES]);
    expect(where.status.in).toContain("negotiating_venue");
    expect(where.status.in).toContain("scheduled");
    expect(where.OR).toEqual([{ userAId: LEAVING }, { userBId: LEAVING }]);
  });

  it("cancels a scheduled match, comps the partner, and DMs the telegram partner", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m1",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "ru", platform: "telegram" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: { in: [...IN_FLIGHT_MATCH_STATUSES] } },
      data: { status: "cancelled" },
    });
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0];
    expect(chatId).toBe(200);
    expect(typeof body).toBe("string");
    expect(result).toEqual([
      {
        matchId: "m1",
        partnerUserId: PARTNER,
        partnerTelegramId: 200n,
        partnerLanguage: "ru",
        partnerPlatform: "telegram",
        ticketRefunds: [],
      },
    ]);
  });

  it("resolves the partner as userA when the leaving user is side B", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m2",
        userAId: PARTNER,
        userBId: LEAVING,
        userA: { telegramId: 300n, language: "en", platform: "telegram" },
        userB: { telegramId: 400n, language: "en", platform: "telegram" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage.mock.calls[0][0]).toBe(300);
    expect(result[0].partnerUserId).toBe(PARTNER);
  });

  it("pushes a neutral cancellation notice to a mobile-only partner", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m3",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: -7n, language: "en", platform: "mobile" },
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    await cancelInFlightMatchesForUser(LEAVING, api);

    expect(mMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mPush).toHaveBeenCalledWith(PARTNER, {
      title: "Gennety",
      body: expect.any(String),
      data: { type: "match.cancelled", matchId: "m3" },
    });
  });

  it("with api=null, cancels + comps without sending any DM", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m4",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);

    const result = await cancelInFlightMatchesForUser(LEAVING, null);

    expect(mMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
    expect(result).toHaveLength(1);
  });

  it("continues to the next match when one status update throws", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "bad",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
      {
        id: "good",
        userAId: LEAVING,
        userBId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 300n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.updateMany
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({ count: 1 });
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    const result = await cancelInFlightMatchesForUser(LEAVING, api);

    // The failed match is skipped; the good one still cancels + notifies.
    expect(result).toEqual([
      {
        matchId: "good",
        partnerUserId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        partnerTelegramId: 300n,
        partnerLanguage: "en",
        partnerPlatform: "telegram",
        ticketRefunds: [],
      },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a concurrently resolved match or double-compensate", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "raced",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await cancelInFlightMatchesForUser(LEAVING, null);

    expect(result).toEqual([]);
    expect(mComp).not.toHaveBeenCalled();
  });

  it("propagates DB cancellation failures in strict mode", async () => {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "bad",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(
      cancelInFlightMatchesForUser(LEAVING, null, { strict: true }),
    ).rejects.toThrow("db down");
  });
});

/**
 * PRODUCT_SPEC §3.5b — a dead match returns every paid Date Ticket to its
 * payer. This rail is shared by freeze, hard delete, and both moderation
 * paths, so wiring it here is what covers all four.
 */
describe("cancelInFlightMatchesForUser — Date Ticket refunds", () => {
  const paidGate = (over: Record<string, unknown> = {}) => ({
    ticketStatus: "completed",
    ticketPaidA: new Date(),
    ticketPaidB: new Date(),
    paidForPartnerByA: false,
    paidForPartnerByB: false,
    ...over,
  });

  function gate(over: Record<string, unknown> = {}): void {
    mMatch.findMany.mockResolvedValueOnce([
      {
        id: "m1",
        userAId: LEAVING,
        userBId: PARTNER,
        userA: { telegramId: 100n, language: "en", platform: "telegram" },
        userB: { telegramId: 200n, language: "en", platform: "telegram" },
      },
    ]);
    mMatch.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      ...paidGate(over),
      userAId: LEAVING,
      userBId: PARTNER,
      userA: { telegramId: 100n, language: "en", platform: "telegram" },
      userB: { telegramId: 200n, language: "en", platform: "telegram" },
    }));
  }

  it("refunds one ticket to each side and tells both of them", async () => {
    gate();
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof cancelInFlightMatchesForUser>[1];

    await cancelInFlightMatchesForUser(LEAVING, api);

    const credited = mUser.update.mock.calls.map((c) => c[0].where.id);
    expect(credited.sort()).toEqual([LEAVING, PARTNER].sort());
    expect(mLedger.create).toHaveBeenCalledTimes(2);
    const keys = mLedger.create.mock.calls.map((c) => c[0].data.externalPaymentId);
    expect(keys).toContain(`refund:match:m1:${LEAVING}:A`);
    expect(keys).toContain(`refund:match:m1:${PARTNER}:B`);
    for (const call of mLedger.create.mock.calls) {
      expect(call[0].data.reason).toBe("refund");
      expect(call[0].data.delta).toBe(1);
    }

    // The partner's neutral notice carries the refund line; the leaving user
    // gets a standalone one, since this rail sends them nothing else.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const bodies = sendMessage.mock.calls.map((c) => c[1] as string);
    expect(bodies.filter((b) => b.includes("wallet"))).toHaveLength(2);
  });

  it("returns BOTH tickets to the man who covered them", async () => {
    // `paidForPartnerByA` = A paid for B, so slot B's money is A's too.
    gate({ paidForPartnerByA: true });

    await cancelInFlightMatchesForUser(LEAVING, null);

    const credited = mUser.update.mock.calls.map((c) => c[0].where.id);
    expect(credited).toEqual([LEAVING, LEAVING]);
    const keys = mLedger.create.mock.calls.map((c) => c[0].data.externalPaymentId);
    expect(keys).toEqual([
      `refund:match:m1:${LEAVING}:A`,
      `refund:match:m1:${LEAVING}:B`,
    ]);
  });

  it("refunds the one paid slot of a partial gate", async () => {
    gate({ ticketStatus: "partial", ticketPaidB: null });

    await cancelInFlightMatchesForUser(LEAVING, null);

    expect(mUser.update.mock.calls.map((c) => c[0].where.id)).toEqual([LEAVING]);
    expect(mLedger.create.mock.calls[0][0].data.externalPaymentId).toBe(
      `refund:match:m1:${LEAVING}:A`,
    );
  });

  it("stands down when the ticket-expiry rail already owns the refund", async () => {
    for (const ticketStatus of ["refunded", "refund_pending", "expired"]) {
      vi.clearAllMocks();
      mMatch.updateMany.mockResolvedValue({ count: 1 });
      mUser.findUnique.mockResolvedValue({ id: LEAVING });
      mTx.mockImplementation(async (ops: unknown) => Promise.all(ops as Promise<unknown>[]));
      gate({ ticketStatus });

      await cancelInFlightMatchesForUser(LEAVING, null);

      expect(mUser.update, ticketStatus).not.toHaveBeenCalled();
    }
  });

  it("refunds nothing when no ticket was ever paid", async () => {
    gate({ ticketStatus: "pending", ticketPaidA: null, ticketPaidB: null });

    await cancelInFlightMatchesForUser(LEAVING, null);

    expect(mUser.update).not.toHaveBeenCalled();
    expect(mLedger.create).not.toHaveBeenCalled();
  });

  it("still refunds the surviving partner when the payer's account is gone", async () => {
    // Hard delete: the leaver's row is cascaded away before the wallet writes.
    gate();
    mUser.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === LEAVING ? null : { id: where.id },
    );

    await cancelInFlightMatchesForUser(LEAVING, null);

    expect(mUser.update.mock.calls.map((c) => c[0].where.id)).toEqual([PARTNER]);
  });

  it("never fails the cancellation because a refund failed", async () => {
    gate();
    mTx.mockRejectedValue(new Error("wallet down"));

    const result = await cancelInFlightMatchesForUser(LEAVING, null);

    expect(result).toHaveLength(1);
    expect(mComp).toHaveBeenCalledWith(PARTNER);
  });
});
