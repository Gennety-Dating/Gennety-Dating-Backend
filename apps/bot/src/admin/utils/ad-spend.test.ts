import { describe, it, expect } from "vitest";
import {
  AD_SPEND_ATTRIBUTION_WINDOW_DAYS,
  AD_SPEND_CATEGORIES,
  UNATTRIBUTED_CHANNEL,
  categoryRequiresUnattributed,
  computeAcquisitionCost,
  isAdSpendCategory,
  isSelfNormalizedChannel,
  isValidCurrency,
  isValidPeriod,
  type AcquisitionCostUserInput,
  type AdSpendEntryInput,
} from "./ad-spend.js";
import { normalizeChannel } from "./growth.js";
import type { PayerIndexEntry } from "../../services/purchases.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const DAY = 86_400_000;

function spend(over: Partial<AdSpendEntryInput> & { channel: string; category: string }): AdSpendEntryInput {
  return {
    periodStart: new Date(NOW.getTime() - 10 * DAY),
    periodEnd: new Date(NOW.getTime() - 5 * DAY),
    amountUsdCents: 10_000,
    ...over,
  };
}

function user(over: Partial<AcquisitionCostUserInput> & { id: string; channel: string }): AcquisitionCostUserInput {
  return {
    createdAt: new Date(NOW.getTime() - 8 * DAY),
    status: "active",
    verificationStatus: "verified",
    ...over,
  };
}

function payer(over: Partial<PayerIndexEntry>): Pick<PayerIndexEntry, "firstPaidAt" | "usdCents"> {
  return { firstPaidAt: new Date(NOW.getTime() - 6 * DAY), usdCents: 700, ...over };
}

// ---------------------------------------------------------------------------
// Category / channel / validation helpers
// ---------------------------------------------------------------------------

describe("category table", () => {
  it("has a window entry for every category", () => {
    for (const c of AD_SPEND_CATEGORIES) {
      expect(AD_SPEND_ATTRIBUTION_WINDOW_DAYS).toHaveProperty(c);
    }
  });

  it("categoryRequiresUnattributed is true exactly for null-window categories", () => {
    expect(categoryRequiresUnattributed("content_production")).toBe(true);
    expect(categoryRequiresUnattributed("agency")).toBe(true);
    expect(categoryRequiresUnattributed("performance_ads")).toBe(false);
    expect(categoryRequiresUnattributed("offline_event")).toBe(false);
    expect(categoryRequiresUnattributed("other")).toBe(false);
  });

  it("isAdSpendCategory rejects an unknown string", () => {
    expect(isAdSpendCategory("performance_ads")).toBe(true);
    expect(isAdSpendCategory("banner_ads")).toBe(false);
  });
});

describe("isSelfNormalizedChannel", () => {
  it("accepts the sentinel unconditionally", () => {
    expect(isSelfNormalizedChannel(UNATTRIBUTED_CHANNEL, normalizeChannel)).toBe(true);
  });

  it("accepts a channel that already equals its own normalization", () => {
    expect(isSelfNormalizedChannel("organic", normalizeChannel)).toBe(true);
    expect(isSelfNormalizedChannel("tg:insta_promo", normalizeChannel)).toBe(true);
    expect(isSelfNormalizedChannel("referral", normalizeChannel)).toBe(true);
  });

  it("rejects a channel that would normalize to something else", () => {
    // Contains "referral" → normalizeChannel collapses it to the bare word.
    expect(isSelfNormalizedChannel("Referral User 42", normalizeChannel)).toBe(false);
    expect(isSelfNormalizedChannel("", normalizeChannel)).toBe(false);
  });
});

describe("isValidCurrency / isValidPeriod", () => {
  it("accepts a 3-letter ISO code, rejects anything else", () => {
    expect(isValidCurrency("USD")).toBe(true);
    expect(isValidCurrency("usd")).toBe(false);
    expect(isValidCurrency("US")).toBe(false);
    expect(isValidCurrency("US$")).toBe(false);
  });

  it("requires periodEnd >= periodStart", () => {
    const a = new Date("2026-08-01T00:00:00Z");
    const b = new Date("2026-08-05T00:00:00Z");
    expect(isValidPeriod(a, b)).toBe(true);
    expect(isValidPeriod(a, a)).toBe(true);
    expect(isValidPeriod(b, a)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeAcquisitionCost
// ---------------------------------------------------------------------------

describe("computeAcquisitionCost", () => {
  it("returns nulls, not zeros or Infinity, when there is no spend at all", () => {
    const out = computeAcquisitionCost({ spend: [], users: [], payers: new Map(), now: NOW });
    expect(out.totalMarketingSpendUsdCents).toBe(0);
    expect(out.attributableSpendUsdCents).toBe(0);
    expect(out.newPayers).toBe(0);
    expect(out.cacPerPayingUsdCents).toBeNull();
    expect(out.cacPerActiveUsdCents).toBeNull();
    expect(out.ltvCac).toBeNull();
    expect(out.roas).toBeNull();
    expect(out.byChannel).toEqual([]);
  });

  it("returns null CAC (not division by zero / Infinity) when spend has zero matching signups", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 })],
      users: [], // nobody registered under this channel at all
      payers: new Map(),
      now: NOW,
    });
    expect(out.attributableSpendUsdCents).toBe(5_000);
    expect(out.newPayers).toBe(0);
    expect(out.cacPerPayingUsdCents).toBeNull();
    expect(out.roas).toBeNull();
    expect(out.byChannel).toEqual([
      expect.objectContaining({ channel: "tg:insta_promo", signups: 0, newPayers: 0, cplUsdCents: null }),
    ]);
  });

  it("computes CPL, CAC, LTV:CAC and ROAS for a single attributed payer", () => {
    const u = user({ id: "u1", channel: "tg:insta_promo" });
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 })],
      users: [u],
      payers: new Map([["u1", payer({})]]),
      now: NOW,
    });
    expect(out.byChannel[0]).toMatchObject({
      channel: "tg:insta_promo",
      signups: 1,
      newPayers: 1,
      newActive: 1,
      cplUsdCents: 5_000,
      cacPerPayingUsdCents: 5_000,
    });
    expect(out.cacPerPayingUsdCents).toBe(5_000);
    expect(out.cacPerActiveUsdCents).toBe(5_000);
    // ltv = 700, cac = 5000 → 0.14
    expect(out.ltvCac).toBe(0.14);
    expect(out.roas).toBe(0.14);
  });

  it("excludes a user who paid outside the attribution window", () => {
    const u = user({ id: "u1", channel: "tg:insta_promo" });
    const entry = spend({
      channel: "tg:insta_promo",
      category: "performance_ads", // 3-day window
      periodStart: new Date(NOW.getTime() - 10 * DAY),
      periodEnd: new Date(NOW.getTime() - 5 * DAY),
    });
    const late = payer({ firstPaidAt: new Date(NOW.getTime() - 1 * DAY) }); // outside the 3d window past periodEnd
    const out = computeAcquisitionCost({
      spend: [entry],
      users: [u],
      payers: new Map([["u1", late]]),
      now: NOW,
    });
    expect(out.byChannel[0].signups).toBe(1); // registered inside the period
    expect(out.byChannel[0].newPayers).toBe(0); // but converted too late
    expect(out.newPayers).toBe(0);
  });

  it("excludes a category with no attribution window from CAC, keeps it in the P&L total", () => {
    const out = computeAcquisitionCost({
      spend: [
        spend({ channel: UNATTRIBUTED_CHANNEL, category: "agency", amountUsdCents: 20_000 }),
        spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 }),
      ],
      users: [user({ id: "u1", channel: "tg:insta_promo" })],
      payers: new Map([["u1", payer({})]]),
      now: NOW,
    });
    expect(out.totalMarketingSpendUsdCents).toBe(25_000);
    expect(out.attributableSpendUsdCents).toBe(5_000);
    // No byChannel row for the unattributed sentinel — nothing can ever match it.
    expect(out.byChannel.map((r) => r.channel)).toEqual(["tg:insta_promo"]);
  });

  it("dedupes a single signup across two overlapping spend entries on one channel", () => {
    const u = user({ id: "u1", channel: "tg:insta_promo" });
    const out = computeAcquisitionCost({
      spend: [
        spend({
          channel: "tg:insta_promo",
          category: "performance_ads",
          periodStart: new Date(NOW.getTime() - 10 * DAY),
          periodEnd: new Date(NOW.getTime() - 5 * DAY),
          amountUsdCents: 3_000,
        }),
        spend({
          channel: "tg:insta_promo",
          category: "performance_ads",
          periodStart: new Date(NOW.getTime() - 9 * DAY),
          periodEnd: new Date(NOW.getTime() - 4 * DAY),
          amountUsdCents: 4_000,
        }),
      ],
      users: [u],
      payers: new Map([["u1", payer({})]]),
      now: NOW,
    });
    expect(out.byChannel[0].signups).toBe(1);
    expect(out.byChannel[0].newPayers).toBe(1);
    expect(out.byChannel[0].spendUsdCents).toBe(7_000); // spend still sums, only the user is deduped
  });

  it("marks a channel unmatured while any attributable entry's window has not elapsed", () => {
    const stillOpen = spend({
      channel: "tg:offline_kyiv",
      category: "offline_event", // 28-day window
      periodStart: new Date(NOW.getTime() - 5 * DAY),
      periodEnd: new Date(NOW.getTime() - 1 * DAY),
    });
    const out = computeAcquisitionCost({
      spend: [stillOpen],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].matured).toBe(false);
    expect(out.matured).toBe(false);
  });

  it("does not attribute a user whose signup falls outside the spend period", () => {
    const u = user({
      id: "u1",
      channel: "tg:insta_promo",
      createdAt: new Date(NOW.getTime() - 20 * DAY), // before periodStart
    });
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads" })],
      users: [u],
      payers: new Map([["u1", payer({})]]),
      now: NOW,
    });
    expect(out.byChannel[0].signups).toBe(0);
  });

  it("keeps two channels' payer sets separate for the blended total", () => {
    const out = computeAcquisitionCost({
      spend: [
        spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 }),
        spend({ channel: "referral", category: "performance_ads", amountUsdCents: 1_000 }),
      ],
      users: [
        user({ id: "u1", channel: "tg:insta_promo" }),
        user({ id: "u2", channel: "referral" }),
      ],
      payers: new Map([
        ["u1", payer({ usdCents: 700 })],
        ["u2", payer({ usdCents: 300 })],
      ]),
      now: NOW,
    });
    expect(out.newPayers).toBe(2);
    expect(out.attributableSpendUsdCents).toBe(6_000);
    expect(out.cacPerPayingUsdCents).toBe(3_000); // 6000 / 2
    // ltv = (700+300)/2 = 500, cac = 3000 → 0.17 (rounded)
    expect(out.ltvCac).toBe(0.17);
  });
});
