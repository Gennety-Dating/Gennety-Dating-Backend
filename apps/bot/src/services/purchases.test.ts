import { describe, it, expect } from "vitest";
import {
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
