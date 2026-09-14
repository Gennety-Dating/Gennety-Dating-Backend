import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    REFERRAL_FEATURE_ENABLED: true,
    REFERRAL_LADDER: [
      { atCount: 1, tickets: 1, months: 1 },
      { atCount: 3, tickets: 1, months: 1 },
      { atCount: 5, tickets: 1, months: 1 },
      { atCount: 10, tickets: 2, months: 2 },
    ] as const,
    REFERRAL_INVITEE_PREMIUM_MONTHS: 1,
    REFERRAL_DAILY_REWARD_CAP: 3,
    TICKET_PRICE_CENTS: 699,
    PREMIUM_PRICE_USD_DISPLAY: "$11.99",
    BOT_USERNAME: "gennetybot",
  },
  findUnique: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  ticketLedgerFindMany: vi.fn(),
  subscriptionLedgerFindMany: vi.fn(),
  $transaction: vi.fn(),
  grantTickets: vi.fn(),
  isUniqueViolation: vi.fn((e: unknown) => (e as { code?: string })?.code === "P2002"),
  grantComplimentaryPremiumMonths: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: h.findUnique,
      findMany: h.findMany,
      updateMany: h.updateMany,
      update: h.update,
      count: h.count,
    },
    ticketLedger: { findMany: h.ticketLedgerFindMany },
    subscriptionLedger: { findMany: h.subscriptionLedgerFindMany },
    $transaction: h.$transaction,
  },
}));
vi.mock("../config.js", () => ({ env: h.env }));
vi.mock("./ticket-wallet.js", () => ({
  grantTickets: h.grantTickets,
  isUniqueViolation: h.isUniqueViolation,
}));
vi.mock("./premium.js", () => ({
  grantComplimentaryPremiumMonths: h.grantComplimentaryPremiumMonths,
}));

const {
  parseReferrer,
  referralSourceFromParam,
  buildReferralLink,
  cumulativeLadderTotals,
  nextLadderRung,
  reconcileReferrerRungs,
  grantReferralRewardsForVerifiedInvitee,
  grantInviteePremium,
  buildReferralStateView,
  referralUsdValue,
  claimReferralCode,
  releaseHeldReferralRewards,
  sweepHeldReferralRewards,
  resetReferralReleaseSweepForTests,
} = await import("./referral.js");

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [h.findUnique, h.findMany, h.count, h.ticketLedgerFindMany, h.subscriptionLedgerFindMany]) {
    fn.mockReset();
  }
  h.ticketLedgerFindMany.mockResolvedValue([]);
  h.subscriptionLedgerFindMany.mockResolvedValue([]);
  resetReferralReleaseSweepForTests();
  h.env.REFERRAL_FEATURE_ENABLED = true;
  h.env.REFERRAL_INVITEE_PREMIUM_MONTHS = 1;
  h.env.REFERRAL_DAILY_REWARD_CAP = 3;
  h.isUniqueViolation.mockImplementation(
    (e: unknown) => (e as { code?: string })?.code === "P2002",
  );
  // Default: run the transaction callback against the same user mocks.
  h.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ user: { updateMany: h.updateMany, update: h.update } }),
  );
  h.grantTickets.mockResolvedValue(1);
  h.grantComplimentaryPremiumMonths.mockResolvedValue({ applied: true, premiumUntil: new Date() });
});

describe("parseReferrer", () => {
  it("parses the canonical referral:<id> form", () => {
    expect(parseReferrer("referral:abc-123")).toBe("abc-123");
  });
  it("parses legacy tg:referral_<id> and tg-mini:referral_<id>", () => {
    expect(parseReferrer("tg:referral_ref-1")).toBe("ref-1");
    expect(parseReferrer("tg-mini:referral_ref-2")).toBe("ref-2");
  });
  it("returns null for non-referral / empty / null sources", () => {
    expect(parseReferrer("tg:ig_story")).toBeNull();
    expect(parseReferrer("mobile:utm=x")).toBeNull();
    expect(parseReferrer("referral:")).toBeNull();
    expect(parseReferrer("")).toBeNull();
    expect(parseReferrer(null)).toBeNull();
  });
});

describe("referralSourceFromParam", () => {
  it("canonicalizes a referral_<id> deep link to referral:<id>", () => {
    expect(referralSourceFromParam("referral_ref-9", "tg")).toBe("referral:ref-9");
    expect(referralSourceFromParam("referral_ref-9", "tg-mini")).toBe("referral:ref-9");
  });
  it("keeps the channel prefix for ordinary campaign params", () => {
    expect(referralSourceFromParam("ig_story", "tg")).toBe("tg:ig_story");
    expect(referralSourceFromParam("launch", "tg-mini")).toBe("tg-mini:launch");
  });
  it("round-trips with parseReferrer for a referral link", () => {
    expect(parseReferrer(referralSourceFromParam("referral_ref-1", "tg"))).toBe("ref-1");
  });
});

describe("buildReferralLink", () => {
  it("builds the start deep link with the referrer id", () => {
    expect(buildReferralLink("ref-1", "gennetybot")).toBe(
      "https://t.me/gennetybot?start=referral_ref-1",
    );
  });
});

describe("cumulativeLadderTotals / nextLadderRung", () => {
  it("accumulates the reached rungs (cumulative totals 1/2/3/5)", () => {
    expect(cumulativeLadderTotals(0)).toEqual({ tickets: 0, months: 0 });
    expect(cumulativeLadderTotals(1)).toEqual({ tickets: 1, months: 1 });
    expect(cumulativeLadderTotals(2)).toEqual({ tickets: 1, months: 1 });
    expect(cumulativeLadderTotals(3)).toEqual({ tickets: 2, months: 2 });
    expect(cumulativeLadderTotals(5)).toEqual({ tickets: 3, months: 3 });
    expect(cumulativeLadderTotals(10)).toEqual({ tickets: 5, months: 5 });
  });
  it("reports the next unreached rung and remaining count", () => {
    expect(nextLadderRung(0)).toEqual({ rung: { atCount: 1, tickets: 1, months: 1 }, remaining: 1 });
    expect(nextLadderRung(1)?.rung.atCount).toBe(3);
    expect(nextLadderRung(1)?.remaining).toBe(2);
    expect(nextLadderRung(10)).toBeNull();
  });
});

describe("reconcileReferrerRungs", () => {
  it("grants tickets + premium for every reached rung, exactly-once by id", async () => {
    const res = await reconcileReferrerRungs("ref", 1);
    expect(res).toEqual({ ticketsApplied: 1, monthsApplied: 1 });
    expect(h.grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "ref",
        count: 1,
        reason: "referral_milestone",
        externalPaymentId: "referral-rung:ref:1:tickets",
      }),
    );
    expect(h.grantComplimentaryPremiumMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "ref",
        months: 1,
        externalPaymentId: "referral-rung:ref:1:premium",
      }),
    );
  });

  it("treats an already-granted rung (P2002) as a no-op, not a throw", async () => {
    h.grantTickets.mockRejectedValueOnce({ code: "P2002" });
    h.grantComplimentaryPremiumMonths.mockResolvedValueOnce({ applied: false, premiumUntil: null });
    const res = await reconcileReferrerRungs("ref", 1);
    expect(res).toEqual({ ticketsApplied: 0, monthsApplied: 0 });
  });

  it("rethrows a non-P2002 ticket error", async () => {
    h.grantTickets.mockRejectedValueOnce({ code: "P2003" });
    await expect(reconcileReferrerRungs("ref", 1)).rejects.toEqual({ code: "P2003" });
  });
});

describe("grantReferralRewardsForVerifiedInvitee", () => {
  /** A member matching could serve: verified, registered, contact proven. */
  const REGISTERED = {
    verificationStatus: "verified",
    onboardingStep: "completed",
    registrationTrack: "general",
    email: null,
    isEmailVerified: false,
    phoneVerifiedAt: new Date("2026-08-01T00:00:00Z"),
  };

  function mockInviteeAndReferrer(
    invitee: Record<string, unknown>,
    referrer: Record<string, unknown> | null,
  ) {
    h.findUnique.mockResolvedValueOnce(invitee);
    if (referrer !== null) h.findUnique.mockResolvedValueOnce(referrer);
  }

  it("no-ops when the feature is off", async () => {
    h.env.REFERRAL_FEATURE_ENABLED = false;
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it("no-ops when there is no referral source", async () => {
    h.findUnique.mockResolvedValueOnce({
      ...REGISTERED,
      id: "inv",
      referralSource: "tg:ig_story",
      referralCountedAt: null,
      phone: null,
    });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
  });

  it("blocks self-referral (source points at the invitee itself)", async () => {
    h.findUnique.mockResolvedValueOnce({
      ...REGISTERED,
      id: "inv",
      referralSource: "referral:inv",
      referralCountedAt: null,
      phone: null,
    });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    // referrer lookup never happens
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });

  it("blocks a shared-phone self-referral", async () => {
    mockInviteeAndReferrer(
      { ...REGISTERED, id: "inv", referralSource: "referral:ref", referralCountedAt: null, phone: "+15551234" },
      { id: "ref", status: "active", phone: "+15551234" },
    );
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
  });

  it("skips a banned referrer", async () => {
    mockInviteeAndReferrer(
      { ...REGISTERED, id: "inv", referralSource: "referral:ref", referralCountedAt: null, phone: null },
      { id: "ref", status: "banned", phone: null },
    );
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
  });

  it("counts once and grants rung 1 on the happy path", async () => {
    mockInviteeAndReferrer(
      { ...REGISTERED, id: "inv", referralSource: "referral:ref", referralCountedAt: null, phone: null },
      { id: "ref", status: "active", phone: null },
    );
    h.updateMany.mockResolvedValueOnce({ count: 1 });
    h.update.mockResolvedValueOnce({ referralVerifiedCount: 1 });
    h.count.mockResolvedValueOnce(1);

    const res = await grantReferralRewardsForVerifiedInvitee("inv");
    expect(res).toEqual({
      referrerId: "ref",
      verifiedCount: 1,
      ticketsApplied: 1,
      monthsApplied: 1,
      heldByVelocity: false,
    });
  });

  it("is idempotent — an already-counted invitee grants nothing", async () => {
    mockInviteeAndReferrer(
      { ...REGISTERED, id: "inv", referralSource: "referral:ref", referralCountedAt: new Date(), phone: null },
      { id: "ref", status: "active", phone: null },
    );
    h.updateMany.mockResolvedValueOnce({ count: 0 }); // CAS loses → already counted
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.grantTickets).not.toHaveBeenCalled();
  });

  // Audit A13-M18: liveness alone used to settle the referral, so an account
  // that never finished registering still paid its referrer.
  it.each([
    ["onboarding is unfinished", { onboardingStep: "conversational" }],
    ["the track contact is unverified", { phoneVerifiedAt: null }],
    ["the invitee is not verified", { verificationStatus: "pending" }],
  ])("counts nothing and pays nothing while %s", async (_label, gap) => {
    h.findUnique.mockResolvedValueOnce({
      ...REGISTERED,
      ...gap,
      id: "inv",
      referralSource: "referral:ref",
      referralCountedAt: null,
      phone: null,
    });

    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    // Not even the referrer lookup, and above all not the count CAS: the
    // invitee stays uncounted for a run that finds them registered.
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.grantTickets).not.toHaveBeenCalled();
  });

  it("holds rewards when the 24h velocity cap is exceeded", async () => {
    mockInviteeAndReferrer(
      { ...REGISTERED, id: "inv", referralSource: "referral:ref", referralCountedAt: null, phone: null },
      { id: "ref", status: "active", phone: null },
    );
    h.updateMany.mockResolvedValueOnce({ count: 1 });
    h.update.mockResolvedValueOnce({ referralVerifiedCount: 4 });
    h.count.mockResolvedValueOnce(4); // > cap of 3

    const res = await grantReferralRewardsForVerifiedInvitee("inv");
    expect(res).toEqual({
      referrerId: "ref",
      verifiedCount: 4,
      ticketsApplied: 0,
      monthsApplied: 0,
      heldByVelocity: true,
    });
    expect(h.grantTickets).not.toHaveBeenCalled();
  });
});

/**
 * A13-M4. The velocity cap held rewards and nothing released them: the promise
 * was "the next under-cap event settles them", and that event is another friend
 * verifying — a referrer whose burst was their last invites never got paid.
 */
describe("releaseHeldReferralRewards", () => {
  /** Rung 1 paid; rung 3 (reached at count 4) held back. */
  function paidRungOneOnly() {
    h.ticketLedgerFindMany.mockResolvedValueOnce([
      { externalPaymentId: "referral-rung:ref:1:tickets" },
    ]);
    h.subscriptionLedgerFindMany.mockResolvedValueOnce([
      { externalPaymentId: "referral-rung:ref:1:premium" },
    ]);
  }

  it("pays a held rung once the referrer is back under the cap", async () => {
    h.findUnique.mockResolvedValueOnce({ id: "ref", status: "active", referralVerifiedCount: 4 });
    paidRungOneOnly();
    h.count.mockResolvedValueOnce(1); // burst is out of the 24h window
    h.grantTickets
      .mockRejectedValueOnce({ code: "P2002" }) // rung 1 already paid
      .mockResolvedValueOnce(2);
    h.grantComplimentaryPremiumMonths
      .mockResolvedValueOnce({ applied: false, premiumUntil: null })
      .mockResolvedValueOnce({ applied: true, premiumUntil: new Date() });

    const res = await releaseHeldReferralRewards("ref");

    expect(res).toEqual({ ticketsApplied: 1, monthsApplied: 1, stillHeld: false });
    expect(h.grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({ externalPaymentId: "referral-rung:ref:3:tickets" }),
    );
  });

  it("keeps holding while the referrer is still over the cap", async () => {
    h.findUnique.mockResolvedValueOnce({ id: "ref", status: "active", referralVerifiedCount: 4 });
    paidRungOneOnly();
    h.count.mockResolvedValueOnce(4); // > cap of 3

    const res = await releaseHeldReferralRewards("ref");

    expect(res).toEqual({ ticketsApplied: 0, monthsApplied: 0, stillHeld: true });
    expect(h.grantTickets).not.toHaveBeenCalled();
  });

  it("does not replay the ladder for a fully paid referrer", async () => {
    h.findUnique.mockResolvedValueOnce({ id: "ref", status: "active", referralVerifiedCount: 1 });
    h.ticketLedgerFindMany.mockResolvedValueOnce([
      { externalPaymentId: "referral-rung:ref:1:tickets" },
    ]);
    h.subscriptionLedgerFindMany.mockResolvedValueOnce([
      { externalPaymentId: "referral-rung:ref:1:premium" },
    ]);

    await releaseHeldReferralRewards("ref");

    expect(h.count).not.toHaveBeenCalled();
    expect(h.grantTickets).not.toHaveBeenCalled();
  });

  it("never releases to a blocked referrer", async () => {
    h.findUnique.mockResolvedValueOnce({ id: "ref", status: "banned", referralVerifiedCount: 4 });
    await releaseHeldReferralRewards("ref");
    expect(h.ticketLedgerFindMany).not.toHaveBeenCalled();
    expect(h.grantTickets).not.toHaveBeenCalled();
  });
});

describe("sweepHeldReferralRewards", () => {
  it("releases only the referrers who are owed a rung, and wraps its page cursor", async () => {
    h.findMany.mockResolvedValueOnce([
      { id: "paid", referralVerifiedCount: 1 },
      { id: "owed", referralVerifiedCount: 1 },
    ]);
    // Batch lookup: `paid` has both rung-1 rows, `owed` has none.
    h.ticketLedgerFindMany.mockResolvedValueOnce([
      { externalPaymentId: "referral-rung:paid:1:tickets" },
    ]);
    h.subscriptionLedgerFindMany.mockResolvedValueOnce([
      { externalPaymentId: "referral-rung:paid:1:premium" },
    ]);
    // The release for `owed` re-reads and re-checks on its own.
    h.findUnique.mockResolvedValueOnce({ id: "owed", status: "active", referralVerifiedCount: 1 });
    h.count.mockResolvedValueOnce(1);

    const res = await sweepHeldReferralRewards();

    expect(res).toEqual({ scanned: 2, released: 1, stillHeld: 0 });
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owed", externalPaymentId: "referral-rung:owed:1:tickets" }),
    );
    // A short page ends the walk: the next tick starts from the beginning.
    h.findMany.mockResolvedValueOnce([]);
    await sweepHeldReferralRewards();
    expect(h.findMany.mock.calls[1]![0].where).not.toHaveProperty("id");
  });

  it("is inert when the program is off", async () => {
    h.env.REFERRAL_FEATURE_ENABLED = false;
    expect(await sweepHeldReferralRewards()).toEqual({ scanned: 0, released: 0, stillHeld: 0 });
    expect(h.findMany).not.toHaveBeenCalled();
  });
});

describe("referralUsdValue / buildReferralStateView", () => {
  it("prices tickets ($6.99) + Premium months ($11.99) correctly", () => {
    expect(referralUsdValue(1, 1)).toBe("$18.98");
    expect(referralUsdValue(5, 5)).toBe("$94.90");
    expect(referralUsdValue(0, 0)).toBe("$0.00");
  });

  it("assembles the ladder view with reached flags + invite link", () => {
    const view = buildReferralStateView("ref-1", 3, "gennetybot");
    expect(view.inviteLink).toBe("https://t.me/gennetybot?start=referral_ref-1");
    expect(view.verifiedCount).toBe(3);
    expect(view.earnedTickets).toBe(2);
    expect(view.earnedMonths).toBe(2);
    expect(view.earnedUsd).toBe("$37.96");
    expect(view.ladder.map((r) => r.reached)).toEqual([true, true, false, false]);
    expect(view.ladder[3]).toMatchObject({ atCount: 10, tickets: 5, months: 5, usd: "$94.90" });
    expect(view.next).toEqual({ atCount: 5, remaining: 2, usd: "$56.94" });
  });

  it("reports next=null once the top rung is reached", () => {
    expect(buildReferralStateView("r", 10, "gennetybot").next).toBeNull();
  });
});

describe("claimReferralCode", () => {
  it("attributes a first-touch mobile invitee to a valid referrer", async () => {
    h.findUnique.mockResolvedValueOnce({ id: "ref" }); // referrer exists
    h.updateMany.mockResolvedValueOnce({ count: 1 }); // first-touch CAS wins
    expect(await claimReferralCode("inv", "ref")).toEqual({ applied: true });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: "inv", referralSource: null },
      data: { referralSource: "referral:ref" },
    });
  });

  it("rejects a self-referral before any DB call", async () => {
    expect(await claimReferralCode("inv", "inv")).toEqual({ applied: false, reason: "invalid" });
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unknown referrer code", async () => {
    h.findUnique.mockResolvedValueOnce(null);
    expect(await claimReferralCode("inv", "ghost")).toEqual({
      applied: false,
      reason: "unknown-referrer",
    });
  });

  it("does not overwrite an existing attribution (first-touch)", async () => {
    h.findUnique.mockResolvedValueOnce({ id: "ref" });
    h.updateMany.mockResolvedValueOnce({ count: 0 }); // already attributed
    expect(await claimReferralCode("inv", "ref")).toEqual({
      applied: false,
      reason: "already-attributed",
    });
  });
});

describe("grantInviteePremium", () => {
  it("grants the welcome month once for a genuinely invited user", async () => {
    h.findUnique.mockResolvedValueOnce({
      id: "inv",
      referralSource: "referral:ref",
      referralInviteePremiumAt: null,
    });
    h.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await grantInviteePremium("inv");
    expect(res).toEqual({ applied: true, months: 1 });
    expect(h.grantComplimentaryPremiumMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "inv",
        months: 1,
        externalPaymentId: "referral-invitee-premium:inv",
      }),
    );
  });

  it("does not re-grant when the once-marker is already set", async () => {
    h.findUnique.mockResolvedValueOnce({
      id: "inv",
      referralSource: "referral:ref",
      referralInviteePremiumAt: new Date(),
    });
    const res = await grantInviteePremium("inv");
    expect(res).toEqual({ applied: false, months: 1 });
    expect(h.grantComplimentaryPremiumMonths).not.toHaveBeenCalled();
  });

  it("does not grant to a self-referral", async () => {
    h.findUnique.mockResolvedValueOnce({
      id: "inv",
      referralSource: "referral:inv",
      referralInviteePremiumAt: null,
    });
    const res = await grantInviteePremium("inv");
    expect(res.applied).toBe(false);
    expect(h.grantComplimentaryPremiumMonths).not.toHaveBeenCalled();
  });
});
