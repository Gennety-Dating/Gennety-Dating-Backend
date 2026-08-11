import { describe, it, expect } from "vitest";
import {
  COHORT_MATURITY_DAYS,
  computeMonetization,
  weekStartOf,
  type MonetizationInput,
  type MonetizationUserInput,
} from "./monetization.js";
import { PURCHASE_KINDS } from "../../services/purchases.js";
import type { PayerIndexEntry, PurchaseKind } from "../../services/purchases.js";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const DAY = 86_400_000;

function user(over: Partial<MonetizationUserInput> & { id: string }): MonetizationUserInput {
  return {
    isTest: false,
    gender: "male",
    registrationTrack: "general",
    referralSource: null,
    cityKey: "ua:kyiv",
    createdAt: new Date(NOW.getTime() - 60 * DAY),
    status: "active",
    verificationStatus: "verified",
    ...over,
  };
}

function payer(
  over: Partial<PayerIndexEntry> & { userId: string },
): PayerIndexEntry {
  const byKind = Object.fromEntries(
    PURCHASE_KINDS.map((k) => [k, { purchases: 0, stars: 0, usdCents: 0 }]),
  ) as PayerIndexEntry["byKind"];
  return {
    purchases: 1,
    refundedCount: 0,
    stars: 350,
    usdCents: 700,
    firstPaidAt: new Date(NOW.getTime() - 30 * DAY),
    lastPaidAt: new Date(NOW.getTime() - 30 * DAY),
    byKind,
    refundedOnly: false,
    ...over,
  };
}

/** Записать покупку в разбивку по виду, не забыв согласовать итоги. */
function withKind(
  entry: PayerIndexEntry,
  kind: PurchaseKind,
  totals: { purchases: number; stars: number; usdCents: number },
): PayerIndexEntry {
  entry.byKind[kind] = totals;
  return entry;
}

function run(over: Partial<MonetizationInput> = {}) {
  const base: MonetizationInput = {
    users: [],
    payers: new Map(),
    payersThisWeek: new Map(),
    payersLastWeek: new Map(),
    paywallReached: new Set(),
    now: NOW,
  };
  return computeMonetization({ ...base, ...over });
}

// ---------------------------------------------------------------------------

describe("weekStartOf", () => {
  it("collapses any day to the Monday of its ISO week, in UTC", () => {
    // 2026-08-10 is a Monday; the whole week must share its key.
    expect(weekStartOf(new Date("2026-08-10T00:00:00Z"))).toBe("2026-08-10");
    expect(weekStartOf(new Date("2026-08-16T23:59:59Z"))).toBe("2026-08-10");
    // Sunday belongs to the PREVIOUS Monday, not the next one.
    expect(weekStartOf(new Date("2026-08-09T12:00:00Z"))).toBe("2026-08-03");
  });
});

describe("computeMonetization — the denominator", () => {
  it("excludes test accounts from BOTH ends of the fraction", () => {
    // The production shape that motivated this: 3 real users, 2 seeded
    // synthetic ones. Counting them makes 1/5 = 20% out of a true 1/3 = 33%.
    const out = run({
      users: [
        user({ id: "real-payer" }),
        user({ id: "real-1" }),
        user({ id: "real-2" }),
        user({ id: "synthetic-1", isTest: true }),
        user({ id: "synthetic-2", isTest: true }),
      ],
      payers: new Map([["real-payer", payer({ userId: "real-payer" })]]),
    });

    expect(out.headline.registeredReal).toBe(3);
    expect(out.headline.payers).toBe(1);
    expect(out.headline.payingRatePct).toBe(33.3);
    expect(out.excludedTestUsers).toBe(2);
  });

  it("keeps a test account's money out of revenue, but reports it separately", () => {
    const out = run({
      users: [user({ id: "real" }), user({ id: "founder", isTest: true })],
      payers: new Map([
        ["founder", payer({ userId: "founder", usdCents: 1999 })],
      ]),
    });

    expect(out.headline.payers).toBe(0);
    expect(out.revenue.allTimeUsdCents).toBe(0);
    // Not silently dropped: the ledger DOES show this charge, and an
    // unexplained gap between the two screens reads as a bug.
    expect(out.revenue.excludedTestUsdCents).toBe(1999);
  });

  it("returns null rather than 0% when a denominator is empty", () => {
    const out = run({ users: [] });
    expect(out.headline.payingRatePct).toBeNull();
    expect(out.headline.ofPaywallReached.pct).toBeNull();
    expect(out.revenue.arpuUsdCents).toBeNull();
    expect(out.timing.medianDaysToFirstPayment).toBeNull();
  });

  it("computes all three denominators independently", () => {
    const out = run({
      users: [
        // Paid, activated, reached the gate.
        user({ id: "a" }),
        // Activated and reached the gate, never paid.
        user({ id: "b" }),
        // Registered only — still onboarding, never saw a paywall.
        user({ id: "c", status: "onboarding", verificationStatus: "unverified" }),
      ],
      payers: new Map([["a", payer({ userId: "a" })]]),
      paywallReached: new Set(["a", "b"]),
    });

    expect(out.headline.ofRegistered).toEqual({ payers: 1, base: 3, pct: 33.3 });
    expect(out.headline.ofActivated).toEqual({ payers: 1, base: 2, pct: 50 });
    expect(out.headline.ofPaywallReached).toEqual({ payers: 1, base: 2, pct: 50 });
  });
});

describe("computeMonetization — what counts as paying", () => {
  it("does not count a user whose every purchase was refunded", () => {
    const out = run({
      users: [user({ id: "u" })],
      payers: new Map([
        [
          "u",
          payer({
            userId: "u",
            purchases: 0,
            refundedCount: 2,
            stars: 0,
            usdCents: 0,
            firstPaidAt: null,
            lastPaidAt: null,
            refundedOnly: true,
          }),
        ],
      ]),
    });

    expect(out.headline.payers).toBe(0);
    expect(out.revenue.allTimeUsdCents).toBe(0);
    // They are not nobody either — they tried and it came back.
    expect(out.refundedOnlyPayers).toBe(1);
  });

  it("counts a partially-refunded user by what actually stuck", () => {
    // `loadPayerIndex` already excludes refunded rows from the totals, so a
    // user with one kept and one returned purchase arrives as purchases: 1.
    const out = run({
      users: [user({ id: "u" })],
      payers: new Map([
        ["u", payer({ userId: "u", purchases: 1, refundedCount: 1, usdCents: 700 })],
      ]),
    });

    expect(out.headline.payers).toBe(1);
    expect(out.revenue.allTimeUsdCents).toBe(700);
    expect(out.refundedOnlyPayers).toBe(0);
  });
});

describe("computeMonetization — revenue", () => {
  it("takes weekly revenue from the WINDOWED index, not lifetime spend", () => {
    // The trap: a repeat buyer whose lifetime spend is $27 but who only spent
    // $7 this week. Attributing lifetime spend to the week of the last
    // purchase would report $27 of weekly revenue that did not happen.
    const users = [user({ id: "u" })];
    const out = run({
      users,
      payers: new Map([
        ["u", payer({ userId: "u", purchases: 3, usdCents: 2700 })],
      ]),
      payersThisWeek: new Map([
        ["u", payer({ userId: "u", purchases: 1, usdCents: 700 })],
      ]),
      payersLastWeek: new Map([
        ["u", payer({ userId: "u", purchases: 1, usdCents: 1400 })],
      ]),
    });

    expect(out.revenue.allTimeUsdCents).toBe(2700);
    expect(out.revenue.thisWeekUsdCents).toBe(700);
    expect(out.revenue.lastWeekUsdCents).toBe(1400);
    expect(out.revenue.growthPct).toBe(-50);
  });

  it("never lets a test account's window revenue in", () => {
    const out = run({
      users: [user({ id: "founder", isTest: true })],
      payersThisWeek: new Map([
        ["founder", payer({ userId: "founder", usdCents: 700 })],
      ]),
    });
    expect(out.revenue.thisWeekUsdCents).toBe(0);
  });

  it("derives ARPU from real users and ARPPU from payers", () => {
    const out = run({
      users: [user({ id: "a" }), user({ id: "b" }), user({ id: "c" })],
      payers: new Map([
        ["a", payer({ userId: "a", purchases: 2, usdCents: 1400 })],
      ]),
    });

    expect(out.revenue.arpuUsdCents).toBe(467); // 1400 / 3 real users
    expect(out.revenue.arppuUsdCents).toBe(1400); // 1400 / 1 payer
    expect(out.revenue.avgOrderUsdCents).toBe(700); // 1400 / 2 purchases
  });

  it("always marks USD as an estimate", () => {
    // Telegram publishes no Stars→USD rate; every dollar figure derived from
    // Stars is a documented constant, and the client has to say so.
    expect(run().revenue.usdIsEstimate).toBe(true);
  });
});

describe("computeMonetization — per-product breakdown", () => {
  it("counts distinct payers per kind and sums that kind's own money", () => {
    const a = withKind(
      withKind(payer({ userId: "a", purchases: 3, usdCents: 2100 }), "tickets", {
        purchases: 2,
        stars: 700,
        usdCents: 1400,
      }),
      "premium",
      { purchases: 1, stars: 750, usdCents: 1799 },
    );
    const b = withKind(payer({ userId: "b", purchases: 1, usdCents: 700 }), "tickets", {
      purchases: 1,
      stars: 350,
      usdCents: 700,
    });

    const out = run({
      users: [user({ id: "a" }), user({ id: "b" })],
      payers: new Map([
        ["a", a],
        ["b", b],
      ]),
    });

    const tickets = out.byKind.find((r) => r.kind === "tickets");
    expect(tickets).toEqual({ kind: "tickets", payers: 2, purchases: 3, usdCents: 2100 });
    const premium = out.byKind.find((r) => r.kind === "premium");
    expect(premium).toEqual({ kind: "premium", payers: 1, purchases: 1, usdCents: 1799 });
    // Products nobody bought are dropped rather than shown as zero rows.
    expect(out.byKind.map((r) => r.kind)).toEqual(["tickets", "premium"]);
  });
});

describe("computeMonetization — cohorts", () => {
  it("flags the newest cohort as censored so its 0% is not read as a result", () => {
    const out = run({
      users: [
        user({ id: "old", createdAt: new Date(NOW.getTime() - 60 * DAY) }),
        user({
          id: "fresh",
          createdAt: new Date(NOW.getTime() - (COHORT_MATURITY_DAYS - 1) * DAY),
        }),
      ],
    });

    const fresh = out.cohorts.find((c) => c.censored);
    expect(fresh).toBeDefined();
    expect(fresh?.size).toBe(1);
    // The mature cohort is not flagged.
    expect(out.cohorts.filter((c) => !c.censored)).toHaveLength(1);
    expect(out.cohortMaturityDays).toBe(COHORT_MATURITY_DAYS);
  });

  it("sorts cohorts newest first", () => {
    const out = run({
      users: [
        user({ id: "a", createdAt: new Date("2026-06-01T00:00:00Z") }),
        user({ id: "b", createdAt: new Date("2026-07-01T00:00:00Z") }),
      ],
    });
    expect(out.cohorts[0]!.weekStart > out.cohorts[1]!.weekStart).toBe(true);
  });
});

describe("computeMonetization — segments", () => {
  it("splits by channel, gender, city and track, ordered by payers", () => {
    const out = run({
      users: [
        user({ id: "m", gender: "male", referralSource: "tg:ads_aug", cityKey: "ua:kyiv" }),
        user({ id: "f", gender: "female", referralSource: null, cityKey: "ua:kyiv" }),
        user({ id: "f2", gender: "female", referralSource: null, cityKey: "ua:kyiv" }),
      ],
      payers: new Map([["m", payer({ userId: "m", usdCents: 700 })]]),
    });

    // The paying channel leads even though `organic` has more users — the cut
    // is read to answer "where does the money come from".
    expect(out.segments.byChannel[0]).toEqual({
      key: "tg:ads_aug",
      users: 1,
      payers: 1,
      payingRatePct: 100,
      usdCents: 700,
    });
    expect(out.segments.byChannel[1]?.key).toBe("organic");
    expect(out.segments.byGender[0]?.key).toBe("male");
    expect(out.segments.byCity[0]).toMatchObject({ key: "ua:kyiv", users: 3, payers: 1 });
    expect(out.segments.byTrack[0]?.key).toBe("general");
  });

  it("buckets missing attributes rather than dropping the user", () => {
    const out = run({
      users: [user({ id: "u", gender: null, cityKey: null, registrationTrack: null })],
    });
    expect(out.segments.byGender[0]?.key).toBe("unknown");
    expect(out.segments.byCity[0]?.key).toBe("unknown");
    // Pre-fork accounts have no track at all; they are legacy, not unknown.
    expect(out.segments.byTrack[0]?.key).toBe("legacy");
  });
});

describe("computeMonetization — repeat and timing", () => {
  it("separates one-time from repeat payers", () => {
    const out = run({
      users: [user({ id: "a" }), user({ id: "b" })],
      payers: new Map([
        ["a", payer({ userId: "a", purchases: 1 })],
        ["b", payer({ userId: "b", purchases: 3 })],
      ]),
    });

    expect(out.repeat).toEqual({
      oncePayers: 1,
      repeatPayers: 1,
      repeatRatePct: 50,
      purchasesPerPayer: 2,
    });
  });

  it("measures days from signup to FIRST payment", () => {
    const out = run({
      users: [
        user({ id: "a", createdAt: new Date(NOW.getTime() - 40 * DAY) }),
        user({ id: "b", createdAt: new Date(NOW.getTime() - 32 * DAY) }),
      ],
      payers: new Map([
        // both first paid 30 days ago → 10 and 2 days after signup
        ["a", payer({ userId: "a" })],
        ["b", payer({ userId: "b" })],
      ]),
    });

    // Samples are [2, 10]: the median interpolates to 6, and p90 to
    // 2 + (10 − 2) × 0.9 = 9.2.
    expect(out.timing.medianDaysToFirstPayment).toBe(6);
    expect(out.timing.p90DaysToFirstPayment).toBe(9.2);
  });

  it("counts a new payer by first payment, not by any payment in the window", () => {
    const out = run({
      users: [user({ id: "new" }), user({ id: "returning" })],
      payers: new Map([
        ["new", payer({ userId: "new", firstPaidAt: new Date(NOW.getTime() - 2 * DAY) })],
        [
          "returning",
          payer({
            userId: "returning",
            purchases: 2,
            firstPaidAt: new Date(NOW.getTime() - 200 * DAY),
            lastPaidAt: new Date(NOW.getTime() - 1 * DAY),
          }),
        ],
      ]),
      // Both spent money this week, but only one of them is NEW.
      payersThisWeek: new Map([
        ["new", payer({ userId: "new" })],
        ["returning", payer({ userId: "returning" })],
      ]),
    });

    expect(out.headline.newPayersThisWeek).toBe(1);
  });
});

describe("computeMonetization — truncation", () => {
  it("passes the payer-index ceiling flag through", () => {
    expect(run({ truncated: true }).truncated).toBe(true);
    expect(run().truncated).toBe(false);
  });
});
