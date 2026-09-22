import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    REFERRAL_FEATURE_ENABLED: true,
    REFERRAL_TICKETS_PER_FRIEND: 1,
    REFERRAL_INVITEE_TICKETS: 1,
    REFERRAL_MAX_REWARDED_FRIENDS: 20,
    REFERRAL_DAILY_REWARD_CAP: 3,
    BOT_USERNAME: "gennetybot",
  },
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userUpdateMany: vi.fn(),
  userUpdate: vi.fn(),
  qualGroupBy: vi.fn(),
  qualCount: vi.fn(),
  qualCreate: vi.fn(),
  qualFindMany: vi.fn(),
  qualUpdateMany: vi.fn(),
  identityCount: vi.fn(),
  identityCreateMany: vi.fn(),
  $transaction: vi.fn(),
  grantTicketsInTx: vi.fn(),
  keyedIdentitiesOf: vi.fn(),
  grantComplimentaryPremiumMonths: vi.fn(),
}));

const referralQualification = {
  groupBy: h.qualGroupBy,
  count: h.qualCount,
  create: h.qualCreate,
  findMany: h.qualFindMany,
  updateMany: h.qualUpdateMany,
};
const referralIdentity = { count: h.identityCount, createMany: h.identityCreateMany };
const user = {
  findUnique: h.userFindUnique,
  findUniqueOrThrow: h.userFindUniqueOrThrow,
  updateMany: h.userUpdateMany,
  update: h.userUpdate,
};

vi.mock("@gennety/db", () => ({
  prisma: { user, referralQualification, referralIdentity, $transaction: h.$transaction },
}));
vi.mock("../config.js", () => ({ env: h.env }));
vi.mock("./ticket-wallet.js", () => ({ grantTicketsInTx: h.grantTicketsInTx }));
vi.mock("./safety-tombstone.js", () => ({ keyedIdentitiesOf: h.keyedIdentitiesOf }));
// Referral must never reach Premium again (decision 2026-09-22). If anything in
// the module started calling it, these spies would record it.
vi.mock("./premium.js", () => ({
  grantComplimentaryPremiumMonths: h.grantComplimentaryPremiumMonths,
}));

const {
  parseReferrer,
  referralSourceFromParam,
  buildReferralLink,
  referralLedgerKey,
  grantReferralRewardsForVerifiedInvitee,
  buildReferralStateView,
  claimReferralCode,
  releaseHeldReferralRewards,
  sweepHeldReferralRewards,
  resetReferralReleaseSweepForTests,
  markReferralGiftSeen,
} = await import("./referral.js");

const IDENTITIES = [
  { kind: "telegram", identityHash: "h-tg" },
  { kind: "phone", identityHash: "h-phone" },
];

beforeEach(() => {
  vi.resetAllMocks();
  resetReferralReleaseSweepForTests();
  Object.assign(h.env, {
    REFERRAL_FEATURE_ENABLED: true,
    REFERRAL_TICKETS_PER_FRIEND: 1,
    REFERRAL_INVITEE_TICKETS: 1,
    REFERRAL_MAX_REWARDED_FRIENDS: 20,
    REFERRAL_DAILY_REWARD_CAP: 3,
  });
  // Every transaction runs its callback against the same model mocks.
  h.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ user, referralQualification, referralIdentity }),
  );
  h.keyedIdentitiesOf.mockReturnValue(IDENTITIES);
  h.identityCount.mockResolvedValue(0);
  h.identityCreateMany.mockResolvedValue({ count: IDENTITIES.length });
  h.qualCreate.mockResolvedValue({ id: "q1" });
  h.grantTicketsInTx.mockResolvedValue(1);
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

describe("grantReferralRewardsForVerifiedInvitee", () => {
  /** A member matching could serve: verified, registered, contact proven. */
  const REGISTERED = {
    status: "active",
    telegramId: 555n,
    verificationStatus: "verified",
    onboardingStep: "completed",
    registrationTrack: "general",
    email: null,
    isEmailVerified: false,
    phoneVerifiedAt: new Date("2026-08-01T00:00:00Z"),
  };
  const INVITEE = {
    ...REGISTERED,
    id: "inv",
    referralSource: "referral:ref",
    referralCountedAt: null,
    phone: null,
  };
  const REFERRER = { id: "ref", status: "active", phone: null };

  /** Invitee + referrer lookups, the count CAS winning, and the tally bump. */
  function arrangeSettle(opts: { slotsUsed?: number; recent?: number; verifiedCount?: number } = {}) {
    h.userFindUnique.mockResolvedValueOnce(INVITEE).mockResolvedValueOnce(REFERRER);
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    h.userUpdate.mockResolvedValueOnce({ referralVerifiedCount: opts.verifiedCount ?? 1 });
    // First count = used reward slots, second = the 24h velocity window.
    h.qualCount.mockResolvedValueOnce(opts.slotsUsed ?? 0).mockResolvedValueOnce(opts.recent ?? 0);
  }

  it("no-ops when the feature is off", async () => {
    h.env.REFERRAL_FEATURE_ENABLED = false;
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("no-ops when there is no referral source", async () => {
    h.userFindUnique.mockResolvedValueOnce({ ...INVITEE, referralSource: "tg:ig_story" });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.$transaction).not.toHaveBeenCalled();
  });

  it("blocks self-referral (source points at the invitee itself)", async () => {
    h.userFindUnique.mockResolvedValueOnce({ ...INVITEE, referralSource: "referral:inv" });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.userFindUnique).toHaveBeenCalledTimes(1); // referrer lookup never happens
  });

  it("blocks a shared-phone self-referral", async () => {
    h.userFindUnique
      .mockResolvedValueOnce({ ...INVITEE, phone: "+15551234" })
      .mockResolvedValueOnce({ ...REFERRER, phone: "+15551234" });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.$transaction).not.toHaveBeenCalled();
  });

  it("skips a banned referrer", async () => {
    h.userFindUnique
      .mockResolvedValueOnce(INVITEE)
      .mockResolvedValueOnce({ ...REFERRER, status: "banned" });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.$transaction).not.toHaveBeenCalled();
  });

  // Audit A13-M18 + decision 2026-09-22: an account matching could not serve —
  // or one moderation has blocked — neither counts nor pays anyone.
  it.each([
    ["onboarding is unfinished", { onboardingStep: "conversational" }],
    ["the track contact is unverified", { phoneVerifiedAt: null }],
    ["the invitee is not verified", { verificationStatus: "pending" }],
    ["the invitee is suspended", { status: "suspended" }],
  ])("counts nothing and pays nothing while %s", async (_label, gap) => {
    h.userFindUnique.mockResolvedValueOnce({ ...INVITEE, ...gap });

    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    // Not even the referrer lookup, and above all not the count CAS: the
    // invitee stays uncounted for a run that finds them eligible.
    expect(h.userFindUnique).toHaveBeenCalledTimes(1);
    expect(h.userUpdateMany).not.toHaveBeenCalled();
    expect(h.grantTicketsInTx).not.toHaveBeenCalled();
  });

  it("counts once and pays both sides one ticket in one transaction", async () => {
    arrangeSettle();

    const res = await grantReferralRewardsForVerifiedInvitee("inv");

    expect(res).toEqual({
      referrerId: "ref",
      qualificationId: "q1",
      status: "credited",
      verifiedCount: 1,
      referrerTicketsApplied: 1,
      inviteeTicketsApplied: 1,
      rewardsLeft: 19,
    });
    expect(h.$transaction).toHaveBeenCalledTimes(1);
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv", referralCountedAt: null },
      data: { referralCountedAt: expect.any(Date) },
    });
    expect(h.qualCreate.mock.calls[0]![0].data).toMatchObject({
      inviteeId: "inv",
      referrerId: "ref",
      status: "credited",
      referrerTickets: 1,
      inviteeTickets: 1,
      creditedAt: expect.any(Date),
    });
    expect(h.identityCreateMany).toHaveBeenCalledWith({
      data: [
        { identityHash: "h-tg", kind: "telegram", qualificationId: "q1" },
        { identityHash: "h-phone", kind: "phone", qualificationId: "q1" },
      ],
      skipDuplicates: true,
    });
    expect(h.grantTicketsInTx.mock.calls.map((call) => call[1])).toEqual([
      { userId: "ref", count: 1, reason: "referral_reward", externalPaymentId: "referral:q1:referrer" },
      { userId: "inv", count: 1, reason: "referral_reward", externalPaymentId: "referral:q1:invitee" },
    ]);
    expect(h.grantComplimentaryPremiumMonths).not.toHaveBeenCalled();
  });

  it("is idempotent — an already-counted invitee writes and grants nothing", async () => {
    h.userFindUnique.mockResolvedValueOnce(INVITEE).mockResolvedValueOnce(REFERRER);
    h.userUpdateMany.mockResolvedValueOnce({ count: 0 }); // CAS loses → already counted

    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toBeNull();
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.qualCreate).not.toHaveBeenCalled();
    expect(h.grantTicketsInTx).not.toHaveBeenCalled();
  });

  it("pays nobody for a re-registered identity and does not count it", async () => {
    h.userFindUnique.mockResolvedValueOnce(INVITEE).mockResolvedValueOnce(REFERRER);
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    h.identityCount.mockResolvedValueOnce(1); // this phone was counted before
    h.userFindUniqueOrThrow.mockResolvedValueOnce({ referralVerifiedCount: 4 });

    const res = await grantReferralRewardsForVerifiedInvitee("inv");

    expect(res).toMatchObject({
      status: "duplicate",
      verifiedCount: 4,
      referrerTicketsApplied: 0,
      inviteeTicketsApplied: 0,
    });
    expect(h.userUpdate).not.toHaveBeenCalled(); // tally untouched
    expect(h.qualCreate.mock.calls[0]![0].data).toMatchObject({
      status: "duplicate",
      referrerTickets: 0,
      inviteeTickets: 0,
      creditedAt: null,
    });
    // The new account's identities join the tombstone too.
    expect(h.identityCreateMany).toHaveBeenCalledTimes(1);
    expect(h.grantTicketsInTx).not.toHaveBeenCalled();
  });

  it("stops paying the referrer at the lifetime cap but still pays the friend", async () => {
    arrangeSettle({ slotsUsed: 20, verifiedCount: 21 });

    const res = await grantReferralRewardsForVerifiedInvitee("inv");

    expect(res).toMatchObject({
      status: "capped",
      referrerTicketsApplied: 0,
      inviteeTicketsApplied: 1,
      rewardsLeft: 0,
    });
    expect(h.qualCreate.mock.calls[0]![0].data).toMatchObject({ status: "capped", referrerTickets: 0 });
    expect(h.grantTicketsInTx).toHaveBeenCalledTimes(1);
    expect(h.grantTicketsInTx.mock.calls[0]![1]).toMatchObject({ userId: "inv" });
  });

  it("holds the referrer's ticket over the 24h velocity cap — the friend is still paid", async () => {
    arrangeSettle({ slotsUsed: 5, recent: 3 }); // cap 3 → this one is the 4th in 24h

    const res = await grantReferralRewardsForVerifiedInvitee("inv");

    expect(res).toMatchObject({
      status: "held",
      referrerTicketsApplied: 0,
      inviteeTicketsApplied: 1,
      rewardsLeft: 14, // the held reward reserves its slot
    });
    expect(h.qualCreate.mock.calls[0]![0].data).toMatchObject({
      status: "held",
      referrerTickets: 1,
      creditedAt: null,
    });
    expect(h.grantTicketsInTx.mock.calls.map((call) => call[1].userId)).toEqual(["inv"]);
  });

  it("does not hold anything when the velocity cap is switched off", async () => {
    h.env.REFERRAL_DAILY_REWARD_CAP = 0;
    arrangeSettle({ recent: 50 });
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toMatchObject({ status: "credited" });
  });

  it("pays only the referrer when the invitee side is set to 0", async () => {
    h.env.REFERRAL_INVITEE_TICKETS = 0;
    arrangeSettle();

    const res = await grantReferralRewardsForVerifiedInvitee("inv");

    expect(res).toMatchObject({ referrerTicketsApplied: 1, inviteeTicketsApplied: 0 });
    expect(h.grantTicketsInTx.mock.calls.map((call) => call[1].userId)).toEqual(["ref"]);
  });

  it("uses the configured per-friend amount", async () => {
    h.env.REFERRAL_TICKETS_PER_FRIEND = 2;
    arrangeSettle();
    expect(await grantReferralRewardsForVerifiedInvitee("inv")).toMatchObject({
      referrerTicketsApplied: 2,
    });
    expect(h.grantTicketsInTx.mock.calls[0]![1]).toMatchObject({ userId: "ref", count: 2 });
  });
});

describe("referralLedgerKey", () => {
  it("keys each side of a qualification separately", () => {
    expect(referralLedgerKey("q9", "referrer")).toBe("referral:q9:referrer");
    expect(referralLedgerKey("q9", "invitee")).toBe("referral:q9:invitee");
  });
});

describe("buildReferralStateView", () => {
  it("reports tickets earned and pending, and the reward slots left — no money, no Premium", async () => {
    h.qualGroupBy.mockResolvedValueOnce([
      { status: "credited", _sum: { referrerTickets: 3 }, _count: { _all: 3 } },
      { status: "held", _sum: { referrerTickets: 1 }, _count: { _all: 1 } },
    ]);

    const view = await buildReferralStateView("ref", 5, "gennetybot");

    expect(view).toEqual({
      inviteLink: "https://t.me/gennetybot?start=referral_ref",
      verifiedCount: 5,
      earnedTickets: 3,
      pendingTickets: 1,
      ticketsPerFriend: 1,
      inviteeTickets: 1,
      rewardCap: 20,
      rewardsLeft: 16,
    });
    expect(h.qualGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { referrerId: "ref", status: { in: ["credited", "held"] } } }),
    );
  });

  it("never reports a negative number of rewards left", async () => {
    h.qualGroupBy.mockResolvedValueOnce([
      { status: "credited", _sum: { referrerTickets: 25 }, _count: { _all: 25 } },
    ]);
    expect((await buildReferralStateView("ref", 30, "gennetybot")).rewardsLeft).toBe(0);
  });
});

describe("claimReferralCode", () => {
  it("attributes a first-touch mobile invitee to a valid referrer", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref" }); // referrer exists
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 }); // first-touch CAS wins
    expect(await claimReferralCode("inv", "ref")).toEqual({ applied: true });
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv", referralSource: null },
      data: { referralSource: "referral:ref" },
    });
  });

  it("rejects a self-referral before any DB call", async () => {
    expect(await claimReferralCode("inv", "inv")).toEqual({ applied: false, reason: "invalid" });
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("rejects an unknown referrer code", async () => {
    h.userFindUnique.mockResolvedValueOnce(null);
    expect(await claimReferralCode("inv", "ghost")).toEqual({
      applied: false,
      reason: "unknown-referrer",
    });
  });

  it("does not overwrite an existing attribution (first-touch)", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref" });
    h.userUpdateMany.mockResolvedValueOnce({ count: 0 }); // already attributed
    expect(await claimReferralCode("inv", "ref")).toEqual({
      applied: false,
      reason: "already-attributed",
    });
  });
});

describe("releaseHeldReferralRewards", () => {
  it("is inert when the program is off", async () => {
    h.env.REFERRAL_FEATURE_ENABLED = false;
    expect(await releaseHeldReferralRewards("ref")).toEqual({ ticketsApplied: 0, stillHeld: false });
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("never releases to a blocked referrer", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref", status: "banned" });
    expect(await releaseHeldReferralRewards("ref")).toEqual({ ticketsApplied: 0, stillHeld: false });
    expect(h.qualFindMany).not.toHaveBeenCalled();
  });

  it("does nothing for a referrer with nothing held", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref", status: "active" });
    h.qualFindMany.mockResolvedValueOnce([]);
    expect(await releaseHeldReferralRewards("ref")).toEqual({ ticketsApplied: 0, stillHeld: false });
    expect(h.qualCount).not.toHaveBeenCalled();
  });

  it("keeps holding while the referrer is still over the cap", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref", status: "active" });
    h.qualFindMany.mockResolvedValueOnce([{ id: "q1", referrerTickets: 1 }]);
    h.qualCount.mockResolvedValueOnce(4); // cap 3
    expect(await releaseHeldReferralRewards("ref")).toEqual({ ticketsApplied: 0, stillHeld: true });
    expect(h.grantTicketsInTx).not.toHaveBeenCalled();
  });

  it("credits every held reward once the referrer is back under the cap", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref", status: "active" });
    h.qualFindMany.mockResolvedValueOnce([
      { id: "q1", referrerTickets: 1 },
      { id: "q2", referrerTickets: 1 },
    ]);
    h.qualCount.mockResolvedValueOnce(3); // at the cap, not over it
    h.qualUpdateMany.mockResolvedValue({ count: 1 });

    expect(await releaseHeldReferralRewards("ref")).toEqual({ ticketsApplied: 2, stillHeld: false });
    expect(h.qualUpdateMany).toHaveBeenCalledWith({
      where: { id: "q1", status: "held" },
      data: { status: "credited", creditedAt: expect.any(Date) },
    });
    expect(h.grantTicketsInTx.mock.calls.map((call) => call[1].externalPaymentId)).toEqual([
      "referral:q1:referrer",
      "referral:q2:referrer",
    ]);
  });

  it("does not pay a reward another release already claimed", async () => {
    h.userFindUnique.mockResolvedValueOnce({ id: "ref", status: "active" });
    h.qualFindMany.mockResolvedValueOnce([{ id: "q1", referrerTickets: 1 }]);
    h.qualCount.mockResolvedValueOnce(0);
    h.qualUpdateMany.mockResolvedValueOnce({ count: 0 }); // status CAS lost

    expect(await releaseHeldReferralRewards("ref")).toEqual({ ticketsApplied: 0, stillHeld: false });
    expect(h.grantTicketsInTx).not.toHaveBeenCalled();
  });
});

describe("sweepHeldReferralRewards", () => {
  it("is inert when the program is off", async () => {
    h.env.REFERRAL_FEATURE_ENABLED = false;
    expect(await sweepHeldReferralRewards()).toEqual({ scanned: 0, released: 0, stillHeld: 0 });
    expect(h.qualFindMany).not.toHaveBeenCalled();
  });

  it("releases the referrers with held rewards, one distinct referrer per row", async () => {
    // Page of referrers with something held.
    h.qualFindMany.mockResolvedValueOnce([{ referrerId: "a" }, { referrerId: "b" }]);
    // a: released.
    h.userFindUnique.mockResolvedValueOnce({ id: "a", status: "active" });
    h.qualFindMany.mockResolvedValueOnce([{ id: "qa", referrerTickets: 1 }]);
    h.qualCount.mockResolvedValueOnce(0);
    h.qualUpdateMany.mockResolvedValueOnce({ count: 1 });
    // b: still over the cap.
    h.userFindUnique.mockResolvedValueOnce({ id: "b", status: "active" });
    h.qualFindMany.mockResolvedValueOnce([{ id: "qb", referrerTickets: 1 }]);
    h.qualCount.mockResolvedValueOnce(9);

    expect(await sweepHeldReferralRewards()).toEqual({ scanned: 2, released: 1, stillHeld: 1 });
    expect(h.qualFindMany.mock.calls[0]![0]).toMatchObject({
      where: { status: "held", referrerId: { not: null } },
      distinct: ["referrerId"],
      orderBy: { referrerId: "asc" },
    });
  });
});

describe("markReferralGiftSeen", () => {
  it("stamps the invite-screen marker once and grants nothing", async () => {
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    expect(await markReferralGiftSeen("inv")).toBe(true);
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv", referralGiftSeenAt: null },
      data: { referralGiftSeenAt: expect.any(Date) },
    });
    expect(h.grantTicketsInTx).not.toHaveBeenCalled();
    expect(h.grantComplimentaryPremiumMonths).not.toHaveBeenCalled();
  });

  it("reports false when the marker was already set", async () => {
    h.userUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await markReferralGiftSeen("inv")).toBe(false);
  });
});
