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
import { PURCHASE_KINDS, type PayerIndexEntry, type PayerKindBreakdown } from "../../services/purchases.js";

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
    // Neutral defaults: most fixtures here are about spend/CAC arithmetic and
    // don't care about the funnel/gender split, so a signup defaults to
    // onboarding-complete (the common case for someone who goes on to pay)
    // and an unknown gender (the honest default — nothing here asserts on it
    // unless a test explicitly sets it).
    onboardingStep: "completed",
    gender: null,
    ...over,
  };
}

function emptyByKind(): PayerKindBreakdown {
  return Object.fromEntries(
    PURCHASE_KINDS.map((kind) => [kind, { purchases: 0, stars: 0, usdCents: 0 }]),
  ) as PayerKindBreakdown;
}

function payer(over: Partial<PayerIndexEntry> = {}): PayerIndexEntry {
  return {
    userId: "unused", // the map key is what `computeAcquisitionCost` actually reads
    purchases: 1,
    refundedCount: 0,
    stars: 0,
    usdCents: 700,
    firstPaidAt: new Date(NOW.getTime() - 6 * DAY),
    lastPaidAt: new Date(NOW.getTime() - 6 * DAY),
    byKind: emptyByKind(),
    refundedOnly: false,
    ...over,
  };
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

// ---------------------------------------------------------------------------
// Funnel × channel — completedOnboarding / matched
// ---------------------------------------------------------------------------

describe("byChannel — funnel dimensions", () => {
  it("counts onboarding-completed signups per channel", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads" })],
      users: [
        user({ id: "u1", channel: "tg:insta_promo", onboardingStep: "completed" }),
        user({ id: "u2", channel: "tg:insta_promo", onboardingStep: "conversational" }),
      ],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].signups).toBe(2);
    expect(out.byChannel[0].completedOnboarding).toBe(1);
  });

  it("counts matched signups per channel", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads" })],
      users: [
        user({ id: "u1", channel: "tg:insta_promo", matched: true }),
        user({ id: "u2", channel: "tg:insta_promo", matched: false }),
      ],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].matched).toBe(1);
  });

  it("reads matched as 0 (not an error) when no input user supplied it — a caller that skipped the Match scan", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads" })],
      users: [user({ id: "u1", channel: "tg:insta_promo" })], // `matched` omitted entirely
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].matched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gender × channel
// ---------------------------------------------------------------------------

describe("byChannel.genderKnown", () => {
  it("splits signups by known gender, leaving the rest implicitly unknown", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads" })],
      users: [
        user({ id: "u1", channel: "tg:insta_promo", gender: "male" }),
        user({ id: "u2", channel: "tg:insta_promo", gender: "female" }),
        user({ id: "u3", channel: "tg:insta_promo", gender: null }),
      ],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].signups).toBe(3);
    expect(out.byChannel[0].genderKnown).toEqual({ male: 1, female: 1 });
    // "unknown" is never stored — it's signups minus the two known buckets.
    const { signups, genderKnown } = out.byChannel[0];
    expect(signups - genderKnown.male - genderKnown.female).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Revenue mix by channel
// ---------------------------------------------------------------------------

describe("byChannel.revenueByKind", () => {
  it("splits attributed payers' lifetime revenue by product", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 })],
      users: [user({ id: "u1", channel: "tg:insta_promo" })],
      payers: new Map([
        [
          "u1",
          payer({
            usdCents: 1_000,
            byKind: {
              ...emptyByKind(),
              tickets: { purchases: 2, stars: 0, usdCents: 400 },
              premium: { purchases: 1, stars: 0, usdCents: 600 },
            },
          }),
        ],
      ]),
      now: NOW,
    });
    expect(out.byChannel[0].revenueByKind).toEqual({
      tickets: 400,
      date_ticket: 0,
      premium: 600,
      rematch: 0,
      venue_change: 0,
      prime_time: 0,
    });
  });

  it("zero-fills revenueByKind, never an absent key, when the channel has no attributed payers", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads" })],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].revenueByKind).toEqual({
      tickets: 0,
      date_ticket: 0,
      premium: 0,
      rematch: 0,
      venue_change: 0,
      prime_time: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Payback (LTV:CAC / ROAS) per channel
// ---------------------------------------------------------------------------

describe("byChannel — ltvCac / roas / daysSinceFirstAttributableSpend", () => {
  it("computes ltvCac/roas per channel independently of the blended total", () => {
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
    const insta = out.byChannel.find((r) => r.channel === "tg:insta_promo")!;
    const referral = out.byChannel.find((r) => r.channel === "referral")!;
    // insta: ltv=700, cac=5000 → 0.14
    expect(insta.ltvCac).toBe(0.14);
    expect(insta.roas).toBe(0.14);
    // referral: ltv=300, cac=1000 → 0.30 — different from the blended 0.17,
    // proving this is a per-channel figure and not the pooled one repeated.
    expect(referral.ltvCac).toBe(0.3);
    expect(referral.roas).toBe(0.3);
  });

  it("returns null ltvCac/roas for a channel with spend but no payers, not 0 or Infinity", () => {
    const out = computeAcquisitionCost({
      spend: [spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 })],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].ltvCac).toBeNull();
    expect(out.byChannel[0].roas).toBeNull();
  });

  it("measures days since the channel's EARLIEST attributable spend entry, not the latest", () => {
    const out = computeAcquisitionCost({
      spend: [
        spend({
          channel: "tg:insta_promo",
          category: "performance_ads",
          periodStart: new Date(NOW.getTime() - 30 * DAY),
          periodEnd: new Date(NOW.getTime() - 25 * DAY),
        }),
        spend({
          channel: "tg:insta_promo",
          category: "performance_ads",
          periodStart: new Date(NOW.getTime() - 10 * DAY),
          periodEnd: new Date(NOW.getTime() - 5 * DAY),
        }),
      ],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].daysSinceFirstAttributableSpend).toBe(30);
  });

  it("returns null daysSinceFirstAttributableSpend when the channel's only entry has no attribution window", () => {
    const out = computeAcquisitionCost({
      // A content_production/agency entry against a real channel is refused by
      // the POST route (categoryRequiresUnattributed) — but this function is
      // pure and must degrade honestly if it is ever handed one directly.
      spend: [spend({ channel: "tg:insta_promo", category: "content_production", amountUsdCents: 2_000 })],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byChannel[0].daysSinceFirstAttributableSpend).toBeNull();
    expect(out.byChannel[0].matured).toBe(true); // no window to ever fail to mature
  });
});

// ---------------------------------------------------------------------------
// byEntry — the CAC-over-time trend a single snapshot can't show
// ---------------------------------------------------------------------------

describe("byEntry", () => {
  it("emits one row per attributable spend entry, sorted oldest-first regardless of input order", () => {
    const older = spend({
      channel: "tg:insta_promo",
      category: "performance_ads",
      periodStart: new Date(NOW.getTime() - 20 * DAY),
      periodEnd: new Date(NOW.getTime() - 15 * DAY),
      amountUsdCents: 2_000,
    });
    const newer = spend({
      channel: "tg:insta_promo",
      category: "performance_ads",
      periodStart: new Date(NOW.getTime() - 10 * DAY),
      periodEnd: new Date(NOW.getTime() - 5 * DAY),
      amountUsdCents: 3_000,
    });
    // Passed newest-first — the output must still come back oldest-first.
    const out = computeAcquisitionCost({
      spend: [newer, older],
      users: [
        user({ id: "u-old", channel: "tg:insta_promo", createdAt: new Date(NOW.getTime() - 18 * DAY) }),
        user({ id: "u-new", channel: "tg:insta_promo", createdAt: new Date(NOW.getTime() - 8 * DAY) }),
      ],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byEntry).toHaveLength(2);
    expect(out.byEntry[0].spendUsdCents).toBe(2_000);
    expect(out.byEntry[0].signups).toBe(1);
    expect(out.byEntry[1].spendUsdCents).toBe(3_000);
    expect(out.byEntry[1].signups).toBe(1);
    expect(new Date(out.byEntry[0].periodStart).getTime()).toBeLessThan(
      new Date(out.byEntry[1].periodStart).getTime(),
    );
  });

  it("keeps each entry's signups/newPayers/CAC scoped to itself, not the running channel total", () => {
    const e1 = spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 1_000 });
    const e2 = spend({
      channel: "tg:insta_promo",
      category: "performance_ads",
      periodStart: new Date(NOW.getTime() - 4 * DAY),
      periodEnd: new Date(NOW.getTime() - 2 * DAY),
      amountUsdCents: 1_000,
    });
    const uInE1 = user({ id: "u1", channel: "tg:insta_promo", createdAt: new Date(NOW.getTime() - 8 * DAY) });
    const out = computeAcquisitionCost({
      spend: [e1, e2],
      users: [uInE1],
      payers: new Map([["u1", payer({})]]),
      now: NOW,
    });
    const row1 = out.byEntry.find((r) => r.signups === 1)!;
    const row2 = out.byEntry.find((r) => r.signups === 0)!;
    expect(row1.newPayers).toBe(1);
    expect(row2.newPayers).toBe(0);
    // The channel-level row still shows the union across both entries.
    expect(out.byChannel[0].signups).toBe(1);
    expect(out.byChannel[0].spendUsdCents).toBe(2_000);
  });

  it("excludes unattributed-channel entries from byEntry, same as byChannel", () => {
    const out = computeAcquisitionCost({
      spend: [
        spend({ channel: UNATTRIBUTED_CHANNEL, category: "agency", amountUsdCents: 20_000 }),
        spend({ channel: "tg:insta_promo", category: "performance_ads", amountUsdCents: 5_000 }),
      ],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    expect(out.byEntry).toHaveLength(1);
    expect(out.byEntry[0].channel).toBe("tg:insta_promo");
  });

  it("marks matured per entry independently — a channel can carry both a matured and an open entry", () => {
    const matured = spend({
      channel: "tg:insta_promo",
      category: "performance_ads", // 3-day window
      periodStart: new Date(NOW.getTime() - 10 * DAY),
      periodEnd: new Date(NOW.getTime() - 5 * DAY), // window ends 2 days ago
    });
    const open = spend({
      channel: "tg:insta_promo",
      category: "performance_ads",
      periodStart: new Date(NOW.getTime() - 2 * DAY),
      periodEnd: new Date(NOW.getTime() - 1 * DAY), // window ends tomorrow
    });
    const out = computeAcquisitionCost({
      spend: [matured, open],
      users: [],
      payers: new Map(),
      now: NOW,
    });
    const maturedRow = out.byEntry.find((r) => r.periodEnd === matured.periodEnd.toISOString())!;
    const openRow = out.byEntry.find((r) => r.periodEnd === open.periodEnd.toISOString())!;
    expect(maturedRow.matured).toBe(true);
    expect(openRow.matured).toBe(false);
    // Channel-level: false if ANY of its entries hasn't matured yet.
    expect(out.byChannel[0].matured).toBe(false);
  });
});
