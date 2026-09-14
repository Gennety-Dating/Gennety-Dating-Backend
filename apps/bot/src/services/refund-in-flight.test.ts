import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DELETION_REFUND_DEFER_DAYS } from "@gennety/shared";

vi.mock("./prime-time-purchase.js", () => ({
  PRIME_PURCHASE_PROCESSING: "processing",
  PRIME_PURCHASE_REFUND_FAILED: "refund_failed",
}));
vi.mock("./venue-change-refund.js", () => ({
  VENUE_PURCHASE_PROCESSING: "processing",
  VENUE_PURCHASE_REFUND_FAILED: "refund_failed",
}));

const { findRefundsInFlight } = await import("./refund-in-flight.js");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function db() {
  return {
    ticketLedger: { findMany: vi.fn(async (_args: unknown) => [] as unknown[]) },
    rematchPurchase: { findMany: vi.fn(async (_args: unknown) => [] as unknown[]) },
    venueChangePurchase: { findMany: vi.fn(async (_args: unknown) => [] as unknown[]) },
    primeTimePurchase: { findMany: vi.fn(async (_args: unknown) => [] as unknown[]) },
    match: { findMany: vi.fn(async (_args: unknown) => [] as unknown[]) },
  };
}

let client: ReturnType<typeof db>;
beforeEach(() => {
  client = db();
});

describe("findRefundsInFlight", () => {
  it("asks each rail only for the states its sweep still owns", async () => {
    await findRefundsInFlight(USER_ID, client as never, NOW);

    expect(client.ticketLedger.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        userId: USER_ID,
        externalPaymentId: { not: null },
        reason: { in: ["gate_payment", "gate_processing", "gate_refund_pending"] },
      },
    });
    for (const delegate of [client.rematchPurchase, client.venueChangePurchase, client.primeTimePurchase]) {
      expect(delegate.findMany.mock.calls[0]![0]).toMatchObject({
        where: { userId: USER_ID, status: { in: ["processing", "refund_failed"] } },
      });
    }
    expect(client.match.findMany.mock.calls[0]![0]).toMatchObject({
      where: { ticketStatus: "refund_pending", OR: [{ userAId: USER_ID }, { userBId: USER_ID }] },
    });
  });

  it("finds nothing for an account with no money in flight", async () => {
    await expect(findRefundsInFlight(USER_ID, client as never, NOW)).resolves.toEqual({
      blocking: [],
      stale: [],
    });
  });

  it("splits young refunds (defer) from ones stuck past the window (report and proceed)", async () => {
    const young = new Date(NOW.getTime() - (ACCOUNT_DELETION_REFUND_DEFER_DAYS - 1) * DAY);
    const stale = new Date(NOW.getTime() - (ACCOUNT_DELETION_REFUND_DEFER_DAYS + 1) * DAY);
    client.rematchPurchase.findMany.mockResolvedValueOnce([
      { id: "rp1", status: "refund_failed", createdAt: young },
    ]);
    client.ticketLedger.findMany.mockResolvedValueOnce([
      { id: "tl1", reason: "gate_refund_pending", createdAt: stale },
    ]);
    client.match.findMany.mockResolvedValueOnce([
      { id: "m1", ticketStatus: "refund_pending", updatedAt: young },
    ]);

    const result = await findRefundsInFlight(USER_ID, client as never, NOW);

    expect(result.blocking).toEqual([
      { table: "rematch_purchases", id: "rp1", status: "refund_failed", since: young },
      { table: "matches", id: "m1", status: "refund_pending", since: young },
    ]);
    expect(result.stale).toEqual([
      { table: "ticket_ledger", id: "tl1", status: "gate_refund_pending", since: stale },
    ]);
  });
});
