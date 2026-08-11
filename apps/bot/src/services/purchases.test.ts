import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Almost everything here is pure. `loadPayerIndex` is the exception — it reads
 * the four money tables — so Prisma is stubbed at the module level. The pure
 * tests above are unaffected: they never touch it.
 */
const findMany = vi.hoisted(() => ({
  ticketLedger: vi.fn().mockResolvedValue([]),
  subscriptionLedger: vi.fn().mockResolvedValue([]),
  rematchPurchase: vi.fn().mockResolvedValue([]),
  venueChangePurchase: vi.fn().mockResolvedValue([]),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    ticketLedger: { findMany: findMany.ticketLedger },
    subscriptionLedger: { findMany: findMany.subscriptionLedger },
    rematchPurchase: { findMany: findMany.rematchPurchase },
    venueChangePurchase: { findMany: findMany.venueChangePurchase },
  },
}));

import {
  loadPayerIndex,
  formatPurchaseAmount,
  isPaidTicketRow,
  normalizePurchaseTableStatus,
  normalizeRematchRow,
  normalizeSubscriptionRow,
  normalizeTicketLedgerRow,
  normalizeVenueChangeRow,
  isPaidSubscriptionRow,
  sortPurchases,
  starsToUsdCents,
  summarizePurchases,
  type PurchaseRow,
} from "./purchases.js";

const AT = new Date("2026-08-01T10:00:00.000Z");

describe("isPaidTicketRow", () => {
  it("admits store purchases and every gate row", () => {
    expect(isPaidTicketRow({ reason: "store_purchase" })).toBe(true);
    expect(isPaidTicketRow({ reason: "gate_payment" })).toBe(true);
    expect(isPaidTicketRow({ reason: "gate_refunded" })).toBe(true);
  });

  it("rejects free grants, spends and wallet reversals", () => {
    for (const reason of [
      "welcome_gift",
      "student_bonus",
      "photo_bonus",
      "video_bonus",
      "referral_milestone",
      "promo",
      "spend_match",
      "refund",
    ]) {
      expect(isPaidTicketRow({ reason })).toBe(false);
    }
  });

  it("admits a mock store purchase, which carries no provider charge id", () => {
    // The mock rail writes a priced `store_purchase` row with no charge id.
    // Gating on the charge id would hide every purchase on a mock deployment.
    expect(isPaidTicketRow({ reason: "store_purchase" })).toBe(true);
  });
});

describe("normalizeTicketLedgerRow", () => {
  const base = {
    id: "row-1",
    userId: "u1",
    delta: 3,
    matchId: null,
    amountCents: null,
    amountStars: 830,
    bundleSize: 3,
    externalPaymentId: "tg-charge-1",
    createdAt: AT,
  };

  it("reads a Stars store purchase", () => {
    const row = normalizeTicketLedgerRow({ ...base, reason: "store_purchase" });
    expect(row).toMatchObject({
      kind: "tickets",
      provider: "telegram_stars",
      status: "settled",
      amountStars: 830,
      usdCents: 1660,
      amountIsEstimate: true,
      detail: "3 tickets",
    });
  });

  it("reads an App Store purchase as an exact price, not an estimate", () => {
    const row = normalizeTicketLedgerRow({
      ...base,
      reason: "store_purchase",
      amountStars: null,
      amountCents: 1647,
      externalPaymentId: "appstore:tx-9",
    });
    expect(row.provider).toBe("app_store");
    expect(row.usdCents).toBe(1647);
    expect(row.amountIsEstimate).toBe(false);
  });

  it("reads a row with no charge id as the mock rail", () => {
    const row = normalizeTicketLedgerRow({
      ...base,
      reason: "store_purchase",
      amountStars: null,
      amountCents: 1647,
      externalPaymentId: null,
    });
    expect(row.provider).toBe("mock");
  });

  it("maps the gate reason family onto the normalized lifecycle", () => {
    const gate = (reason: string) =>
      normalizeTicketLedgerRow({ ...base, reason, delta: 0, matchId: "m1", bundleSize: 2 });
    expect(gate("gate_payment").status).toBe("processing");
    expect(gate("gate_settled").status).toBe("settled");
    expect(gate("gate_surplus_pending").status).toBe("settled");
    expect(gate("gate_refunded").status).toBe("refunded");
    // A refund we owe and could not pay is an ops alarm, not a completed
    // refund — it must never read as "money returned".
    expect(gate("gate_refund_pending").status).toBe("refund_failed");
    expect(gate("gate_settled").kind).toBe("date_ticket");
    expect(gate("gate_settled").detail).toContain("2 slots");
  });

  it("marks an App Store credit Apple later revoked as refunded", () => {
    const row = normalizeTicketLedgerRow(
      { ...base, reason: "store_purchase", externalPaymentId: "appstore:tx-9" },
      { refunded: true },
    );
    expect(row.status).toBe("refunded");
  });
});

describe("subscription rows", () => {
  const base = {
    id: "sub-1",
    userId: "u1",
    provider: "telegram_stars",
    event: "started",
    amount: 500,
    currency: "XTR",
    periodEnd: AT,
    externalPaymentId: "tg-sub-1",
    createdAt: AT,
  };

  it("counts only real charges, not lifecycle or comp grants", () => {
    expect(isPaidSubscriptionRow({ event: "started", provider: "telegram_stars" })).toBe(true);
    expect(isPaidSubscriptionRow({ event: "renewed", provider: "app_store" })).toBe(true);
    expect(isPaidSubscriptionRow({ event: "cancelled", provider: "telegram_stars" })).toBe(false);
    expect(isPaidSubscriptionRow({ event: "expired", provider: "app_store" })).toBe(false);
    // Referral / promo months are comped — no money moved.
    expect(isPaidSubscriptionRow({ event: "started", provider: "referral" })).toBe(false);
    expect(isPaidSubscriptionRow({ event: "started", provider: "promo" })).toBe(false);
  });

  it("reads XTR as Stars and anything else as cents", () => {
    expect(normalizeSubscriptionRow(base)).toMatchObject({
      kind: "premium",
      amountStars: 500,
      amountCents: null,
      usdCents: 1000,
      amountIsEstimate: true,
    });
    expect(
      normalizeSubscriptionRow({
        ...base,
        provider: "app_store",
        currency: "USD",
        amount: 999,
        event: "renewed",
      }),
    ).toMatchObject({
      provider: "app_store",
      amountStars: null,
      amountCents: 999,
      usdCents: 999,
      amountIsEstimate: false,
      detail: "monthly renewal",
    });
  });
});

describe("purchase-table statuses", () => {
  it("collapses every source's refunded spelling onto one status", () => {
    expect(normalizePurchaseTableStatus("settled")).toBe("settled");
    expect(normalizePurchaseTableStatus("processing")).toBe("processing");
    expect(normalizePurchaseTableStatus("refunded_no_candidate")).toBe("refunded");
    expect(normalizePurchaseTableStatus("refunded_ineligible")).toBe("refunded");
    expect(normalizePurchaseTableStatus("refunded_race")).toBe("refunded");
    expect(normalizePurchaseTableStatus("refunded_stale")).toBe("refunded");
    expect(normalizePurchaseTableStatus("refund_failed")).toBe("refund_failed");
  });

  it("reads a rematch and a venue-change row", () => {
    expect(
      normalizeRematchRow({
        id: "r1",
        userId: "u1",
        status: "settled",
        amountStars: 150,
        amountCents: 299,
        resultMatchId: "m9",
        externalPaymentId: "tg-r1",
        createdAt: AT,
      }),
    ).toMatchObject({ kind: "rematch", usdCents: 299, amountIsEstimate: false, matchId: "m9" });

    expect(
      normalizeVenueChangeRow({
        id: "v1",
        userId: "u1",
        matchId: "m9",
        status: "refunded_race",
        amountStars: 150,
        externalPaymentId: "tg-v1",
        createdAt: AT,
      }),
    ).toMatchObject({ kind: "venue_change", status: "refunded", usdCents: 300 });
  });
});

describe("summarizePurchases", () => {
  const row = (over: Partial<PurchaseRow>): PurchaseRow => ({
    id: "x",
    source: "rematch_purchase",
    kind: "rematch",
    userId: "u1",
    provider: "telegram_stars",
    status: "settled",
    rawStatus: "settled",
    amountStars: 150,
    amountCents: null,
    currency: "XTR",
    usdCents: 300,
    amountIsEstimate: true,
    detail: null,
    matchId: null,
    externalPaymentId: null,
    createdAt: AT,
    ...over,
  });

  it("excludes refunded rows from revenue but still counts them", () => {
    const totals = summarizePurchases([
      row({ id: "a" }),
      row({ id: "b", status: "refunded" }),
      row({ id: "c", status: "processing" }),
    ]);
    expect(totals).toEqual({ count: 3, stars: 300, usdCents: 600, refundedCount: 1 });
  });

  it("counts refund_failed as revenue — the money is still with us", () => {
    // That state is precisely "we owe a refund we could not pay", so the cash
    // has not left. Treating it as refunded would understate the balance and
    // hide the ops alarm.
    const totals = summarizePurchases([row({ status: "refund_failed" })]);
    expect(totals.stars).toBe(150);
    expect(totals.refundedCount).toBe(0);
  });
});

describe("sortPurchases", () => {
  it("is newest-first and stable on ties", () => {
    const mk = (id: string, iso: string): PurchaseRow =>
      ({ id, createdAt: new Date(iso) }) as PurchaseRow;
    const sorted = sortPurchases([
      mk("b", "2026-08-01T10:00:00Z"),
      mk("c", "2026-07-01T10:00:00Z"),
      mk("a", "2026-08-01T10:00:00Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("formatting", () => {
  it("marks a Stars-derived dollar figure as approximate", () => {
    expect(
      formatPurchaseAmount({
        amountStars: 350,
        amountCents: null,
        currency: "XTR",
        usdCents: 700,
        amountIsEstimate: true,
      }),
    ).toBe("350 ⭐ (≈ $7.00)");
  });

  it("prints a real price without the approximation marker", () => {
    expect(
      formatPurchaseAmount({
        amountStars: null,
        amountCents: 999,
        currency: "USD",
        usdCents: 999,
        amountIsEstimate: false,
      }),
    ).toBe("$9.99");
  });

  it("never invents a number it does not have", () => {
    expect(
      formatPurchaseAmount({
        amountStars: null,
        amountCents: null,
        currency: null,
        usdCents: null,
        amountIsEstimate: false,
      }),
    ).toBe("amount unknown");
  });

  it("uses the documented Stars rate", () => {
    expect(starsToUsdCents(350)).toBe(700);
  });
});

// ---------------------------------------------------------------------------

describe("loadPayerIndex", () => {
  beforeEach(() => {
    for (const fn of Object.values(findMany)) fn.mockReset().mockResolvedValue([]);
  });

  /** A `ticket_ledger` row as Prisma would hand it back. */
  function ticketRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: "t1",
      userId: "u1",
      reason: "store_purchase",
      delta: 3,
      matchId: null,
      amountCents: null,
      amountStars: 830,
      bundleSize: 3,
      externalPaymentId: "charge_1",
      createdAt: AT,
      ...over,
    };
  }

  it("collapses a user's rows into one entry, with per-product totals", async () => {
    findMany.ticketLedger.mockResolvedValue([
      ticketRow({ id: "t2", createdAt: new Date("2026-08-05T10:00:00.000Z") }),
      ticketRow({ id: "t1", createdAt: new Date("2026-08-01T10:00:00.000Z") }),
    ]);
    findMany.subscriptionLedger.mockResolvedValue([
      {
        id: "s1",
        userId: "u1",
        provider: "telegram_stars",
        event: "started",
        amount: 750,
        currency: "XTR",
        periodEnd: null,
        externalPaymentId: "sub_1",
        createdAt: new Date("2026-08-03T10:00:00.000Z"),
      },
    ]);

    const { byUser } = await loadPayerIndex();
    const entry = byUser.get("u1")!;

    expect(entry.purchases).toBe(3);
    expect(entry.stars).toBe(830 + 830 + 750);
    expect(entry.byKind.tickets).toEqual({ purchases: 2, stars: 1660, usdCents: 3320 });
    expect(entry.byKind.premium).toEqual({ purchases: 1, stars: 750, usdCents: 1500 });
    // A product they never bought reads as 0, not undefined.
    expect(entry.byKind.rematch).toEqual({ purchases: 0, stars: 0, usdCents: 0 });
    // Rows arrive newest-first, so first/last must not be read off in order.
    expect(entry.firstPaidAt).toEqual(new Date("2026-08-01T10:00:00.000Z"));
    expect(entry.lastPaidAt).toEqual(new Date("2026-08-05T10:00:00.000Z"));
  });

  it("does not count free grants as purchases", async () => {
    // Reason alone decides it — a welcome gift is a wallet credit, not a sale.
    // The loader pushes this down to SQL, so the filter is asserted there.
    await loadPayerIndex();
    const where = findMany.ticketLedger.mock.calls[0]?.[0]?.where as {
      reason: { in: string[] };
    };
    expect(where.reason.in).toContain("store_purchase");
    expect(where.reason.in).not.toContain("welcome_gift");
    expect(where.reason.in).not.toContain("referral_milestone");
    expect(where.reason.in).not.toContain("promo");
  });

  it("marks a fully-refunded payer rather than dropping them", async () => {
    findMany.ticketLedger.mockResolvedValue([
      ticketRow({ reason: "gate_refunded", externalPaymentId: "charge_r" }),
    ]);

    const { byUser } = await loadPayerIndex();
    const entry = byUser.get("u1")!;

    expect(entry.purchases).toBe(0);
    expect(entry.refundedCount).toBe(1);
    expect(entry.refundedOnly).toBe(true);
    expect(entry.usdCents).toBe(0);
    expect(entry.firstPaidAt).toBeNull();
  });

  it("counts a still-owed refund as money we hold", async () => {
    // `refund_failed` is an ops alarm precisely because the reversal did not
    // happen — the money is still with us, so it is revenue.
    findMany.venueChangePurchase.mockResolvedValue([
      {
        id: "v1",
        userId: "u2",
        matchId: "m1",
        status: "refund_failed",
        amountStars: 150,
        externalPaymentId: "charge_v",
        createdAt: AT,
      },
    ]);

    const { byUser } = await loadPayerIndex();
    expect(byUser.get("u2")).toMatchObject({ purchases: 1, usdCents: 300 });
  });

  it("pushes a date window down to every source", async () => {
    const since = new Date("2026-08-01T00:00:00.000Z");
    await loadPayerIndex({ since });
    for (const fn of Object.values(findMany)) {
      expect(fn.mock.calls[0]?.[0]?.where).toMatchObject({ createdAt: { gte: since } });
    }
  });

  it("reports truncation instead of silently cutting a conversion rate short", async () => {
    // A ceiling hit means every figure derived from the index is partial; a
    // rate computed over a truncated set is wrong, not merely incomplete.
    const { truncated: clean } = await loadPayerIndex();
    expect(clean).toBe(false);

    findMany.ticketLedger.mockResolvedValue(
      Array.from({ length: 20_000 }, (_, i) => ticketRow({ id: `t${i}`, userId: `u${i}` })),
    );
    const { truncated } = await loadPayerIndex();
    expect(truncated).toBe(true);
  });
});
