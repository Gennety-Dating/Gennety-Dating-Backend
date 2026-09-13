import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    PROMO_FEATURE_ENABLED: true,
    PROMO_MANUAL_ENTRY_ENABLED: false,
    PROMO_DEFAULT_TICKETS: 1,
    PROMO_DEFAULT_PREMIUM_MONTHS: 3,
  },
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  promoFindUnique: vi.fn(),
  redemptionFindUnique: vi.fn(),
  redemptionCreate: vi.fn(),
  txExecuteRaw: vi.fn(),
  $transaction: vi.fn(),
  grantTickets: vi.fn(),
  isUniqueViolation: vi.fn((e: unknown) => (e as { code?: string })?.code === "P2002"),
  grantComplimentaryPremiumMonths: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: h.userFindUnique, updateMany: h.userUpdateMany },
    promoCode: { findUnique: h.promoFindUnique },
    promoRedemption: { findUnique: h.redemptionFindUnique },
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
  normalizePromoCode,
  parsePromoCode,
  promoSourceFromParam,
  resolvePromoCode,
  grantPromoRewardsForUser,
  claimPromoCodeForUser,
  claimDeferredPromoForUser,
  isNewPromoAccount,
} = await import("./promo.js");

const HOUR = 60 * 60 * 1000;

function code(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-1",
    code: "SUMMER3M",
    ticketReward: 1,
    premiumMonths: 3,
    maxRedemptions: 500,
    redeemedCount: 0,
    expiresAt: null,
    active: true,
    note: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [h.userFindUnique, h.userUpdateMany, h.promoFindUnique, h.redemptionFindUnique]) {
    fn.mockReset();
  }
  h.redemptionFindUnique.mockResolvedValue(null);
  h.env.PROMO_FEATURE_ENABLED = true;
  h.env.PROMO_MANUAL_ENTRY_ENABLED = false;
  h.isUniqueViolation.mockImplementation(
    (e: unknown) => (e as { code?: string })?.code === "P2002",
  );
  // Default: run the transaction callback against the tx mocks, raw bump = 1 row.
  h.txExecuteRaw.mockResolvedValue(1);
  h.redemptionCreate.mockResolvedValue({});
  h.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ $executeRaw: h.txExecuteRaw, promoRedemption: { create: h.redemptionCreate } }),
  );
  h.grantTickets.mockResolvedValue(1);
  h.grantComplimentaryPremiumMonths.mockResolvedValue({ applied: true, premiumUntil: new Date() });
});

describe("normalizePromoCode", () => {
  it("uppercases and trims", () => {
    expect(normalizePromoCode("  summer3m ")).toBe("SUMMER3M");
  });
});

describe("parsePromoCode", () => {
  it("parses the canonical promo:<CODE> form (normalized)", () => {
    expect(parsePromoCode("promo:summer3m")).toBe("SUMMER3M");
  });
  it("parses legacy tg:promo_<CODE> and tg-mini:promo_<CODE>", () => {
    expect(parsePromoCode("tg:promo_launch")).toBe("LAUNCH");
    expect(parsePromoCode("tg-mini:promo_launch")).toBe("LAUNCH");
  });
  it("returns null for referral / ordinary campaign / empty / null", () => {
    expect(parsePromoCode("referral:abc")).toBeNull();
    expect(parsePromoCode("tg:ig_story")).toBeNull();
    expect(parsePromoCode("promo:")).toBeNull();
    expect(parsePromoCode("")).toBeNull();
    expect(parsePromoCode(null)).toBeNull();
  });
});

describe("promoSourceFromParam", () => {
  it("canonicalizes promo_<CODE> to promo:<CODE> (normalized)", () => {
    expect(promoSourceFromParam("promo_summer3m", "tg")).toBe("promo:SUMMER3M");
    expect(promoSourceFromParam("promo_summer3m", "tg-mini")).toBe("promo:SUMMER3M");
  });
  it("keeps the channel prefix for ordinary / referral params", () => {
    expect(promoSourceFromParam("ig_story", "tg")).toBe("tg:ig_story");
    expect(promoSourceFromParam("referral_ref-1", "tg")).toBe("tg:referral_ref-1");
  });
  it("round-trips with parsePromoCode", () => {
    expect(parsePromoCode(promoSourceFromParam("promo_x1", "tg"))).toBe("X1");
  });
});

describe("resolvePromoCode", () => {
  it("returns null when the feature is off (no DB call)", async () => {
    h.env.PROMO_FEATURE_ENABLED = false;
    expect(await resolvePromoCode("SUMMER3M")).toBeNull();
    expect(h.promoFindUnique).not.toHaveBeenCalled();
  });
  it("returns null for a null / unknown / disabled code", async () => {
    expect(await resolvePromoCode(null)).toBeNull();
    h.promoFindUnique.mockResolvedValueOnce(null);
    expect(await resolvePromoCode("GHOST")).toBeNull();
    h.promoFindUnique.mockResolvedValueOnce(code({ active: false }));
    expect(await resolvePromoCode("SUMMER3M")).toBeNull();
  });
  it("returns null for an expired or exhausted code", async () => {
    h.promoFindUnique.mockResolvedValueOnce(code({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await resolvePromoCode("SUMMER3M")).toBeNull();
    h.promoFindUnique.mockResolvedValueOnce(code({ maxRedemptions: 5, redeemedCount: 5 }));
    expect(await resolvePromoCode("SUMMER3M")).toBeNull();
  });
  it("resolves a valid code (case-insensitive lookup)", async () => {
    h.promoFindUnique.mockResolvedValueOnce(code());
    expect(await resolvePromoCode("summer3m")).toEqual({
      id: "code-1",
      code: "SUMMER3M",
      ticketReward: 1,
      premiumMonths: 3,
    });
    expect(h.promoFindUnique).toHaveBeenCalledWith({ where: { code: "SUMMER3M" } });
  });
});

describe("grantPromoRewardsForUser", () => {
  function mockUser(overrides: Record<string, unknown> = {}) {
    h.userFindUnique.mockResolvedValueOnce({
      id: "u1",
      referralSource: "promo:SUMMER3M",
      promoRedeemedAt: null,
      onboardingStep: "conversational",
      ...overrides,
    });
  }

  it("no-ops when the feature is off", async () => {
    h.env.PROMO_FEATURE_ENABLED = false;
    expect(await grantPromoRewardsForUser("u1")).toBeNull();
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("no-ops when already redeemed", async () => {
    mockUser({ promoRedeemedAt: new Date() });
    expect(await grantPromoRewardsForUser("u1")).toBeNull();
    expect(h.$transaction).not.toHaveBeenCalled();
  });

  it("no-ops when the user has no promo attribution", async () => {
    mockUser({ referralSource: "referral:ref" });
    expect(await grantPromoRewardsForUser("u1")).toBeNull();
    expect(h.promoFindUnique).not.toHaveBeenCalled();
  });

  it("grants ticket + 3 months and stamps the marker on the happy path", async () => {
    mockUser();
    h.promoFindUnique.mockResolvedValueOnce(code());

    const res = await grantPromoRewardsForUser("u1");
    expect(res).toEqual({ code: "SUMMER3M", ticketsApplied: 1, monthsApplied: 3 });
    expect(h.grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        count: 1,
        reason: "promo",
        externalPaymentId: "promo:code-1:u1:tickets",
      }),
    );
    expect(h.grantComplimentaryPremiumMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        months: 3,
        externalPaymentId: "promo:code-1:u1:premium",
        provider: "promo",
      }),
    );
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", promoRedeemedAt: null },
      data: { promoRedeemedAt: expect.any(Date) },
    });
  });

  it("returns null when the code is exhausted at claim time (raw bump touches 0 rows)", async () => {
    mockUser();
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.txExecuteRaw.mockResolvedValueOnce(0);
    expect(await grantPromoRewardsForUser("u1")).toBeNull();
    expect(h.grantTickets).not.toHaveBeenCalled();
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });

  it("treats a racing duplicate redemption (P2002) as a no-op", async () => {
    mockUser();
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.redemptionCreate.mockRejectedValueOnce({ code: "P2002" });
    expect(await grantPromoRewardsForUser("u1")).toBeNull();
    expect(h.grantTickets).not.toHaveBeenCalled();
  });

  // A13-M1: the gift is for the onboarding wow screen of a NEW account.
  it("grants nothing to an account that already finished onboarding", async () => {
    mockUser({ onboardingStep: "completed" });
    expect(await grantPromoRewardsForUser("u1")).toBeNull();
    expect(h.$transaction).not.toHaveBeenCalled();
    expect(h.grantTickets).not.toHaveBeenCalled();
  });

  // A13-L4: the redemption committed before the grants. A failure between them
  // used to leave the slot spent and the gift never granted — the retry hit the
  // unique redemption row and returned null.
  it("resumes a claim whose grants never finished, from the frozen redemption row", async () => {
    mockUser();
    h.redemptionFindUnique.mockResolvedValueOnce({
      promoCodeId: "code-1",
      ticketsApplied: 1,
      monthsApplied: 3,
      promoCode: { code: "SUMMER3M" },
    });

    const res = await grantPromoRewardsForUser("u1");

    expect(res).toEqual({ code: "SUMMER3M", ticketsApplied: 1, monthsApplied: 3 });
    // No second slot is claimed and the code is not re-resolved (it may be full
    // by now — with this very claim).
    expect(h.$transaction).not.toHaveBeenCalled();
    expect(h.promoFindUnique).not.toHaveBeenCalled();
    expect(h.grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({ externalPaymentId: "promo:code-1:u1:tickets" }),
    );
    expect(h.userUpdateMany).toHaveBeenCalled();
  });

  it("leaves the claim resumable when a grant throws", async () => {
    mockUser();
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.grantComplimentaryPremiumMonths.mockRejectedValueOnce(new Error("db blip"));
    await expect(grantPromoRewardsForUser("u1")).rejects.toThrow("db blip");
    // The once-marker is what would block the resume, so it must not be set.
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });

  it("survives an already-granted ticket (P2002) without throwing", async () => {
    mockUser();
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.grantTickets.mockRejectedValueOnce({ code: "P2002" });
    h.grantComplimentaryPremiumMonths.mockResolvedValueOnce({ applied: false, premiumUntil: null });
    const res = await grantPromoRewardsForUser("u1");
    expect(res).toEqual({ code: "SUMMER3M", ticketsApplied: 0, monthsApplied: 0 });
  });
});

describe("claimPromoCodeForUser (iOS first-touch attribution)", () => {
  it("no-ops when the feature is off", async () => {
    h.env.PROMO_FEATURE_ENABLED = false;
    expect(await claimPromoCodeForUser("u1", "SUMMER3M")).toEqual({
      applied: false,
      reason: "disabled",
    });
  });

  it("rejects an invalid / unredeemable code", async () => {
    h.promoFindUnique.mockResolvedValueOnce(null);
    expect(await claimPromoCodeForUser("u1", "GHOST")).toEqual({
      applied: false,
      reason: "invalid",
    });
  });

  it("first-touch attributes a fresh user (referralSource null CAS wins)", async () => {
    const now = new Date("2026-09-14T12:00:00Z");
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    const res = await claimPromoCodeForUser("u1", "summer3m", now);
    expect(res.applied).toBe(true);
    expect(res.resolved?.code).toBe("SUMMER3M");
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "u1",
        referralSource: null,
        onboardingStep: { not: "completed" },
        createdAt: { gte: new Date(now.getTime() - 24 * HOUR) },
      },
      data: { referralSource: "promo:SUMMER3M" },
    });
  });

  it("does not overwrite an existing attribution (first-touch)", async () => {
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.userUpdateMany.mockResolvedValueOnce({ count: 0 });
    h.userFindUnique.mockResolvedValueOnce({ referralSource: "referral:someone" });
    expect(await claimPromoCodeForUser("u1", "SUMMER3M")).toMatchObject({
      applied: false,
      reason: "already-attributed",
    });
  });

  // A13-M1: every native account starts with `referralSource = null`, so the
  // first-touch CAS alone let an account of any age redeem a public code.
  it("refuses an unattributed account that is not new", async () => {
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.userUpdateMany.mockResolvedValueOnce({ count: 0 });
    h.userFindUnique.mockResolvedValueOnce({ referralSource: null });
    expect(await claimPromoCodeForUser("u1", "SUMMER3M")).toEqual({
      applied: false,
      reason: "not-eligible",
    });
  });
});

describe("isNewPromoAccount", () => {
  const now = new Date("2026-09-14T12:00:00Z");

  it("is new only inside the window and before onboarding completes", () => {
    const fresh = new Date(now.getTime() - 2 * HOUR);
    expect(isNewPromoAccount({ createdAt: fresh, onboardingStep: "consent" }, now)).toBe(true);
    expect(isNewPromoAccount({ createdAt: fresh, onboardingStep: "completed" }, now)).toBe(false);
    expect(
      isNewPromoAccount({ createdAt: new Date(now.getTime() - 25 * HOUR), onboardingStep: "consent" }, now),
    ).toBe(false);
  });
});

describe("claimDeferredPromoForUser (iOS claim-deferred)", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const freshAccount = { createdAt: new Date(now.getTime() - HOUR), onboardingStep: "consent" };

  it("refuses an existing account before touching the one-shot fingerprint match", async () => {
    h.userFindUnique.mockResolvedValueOnce({
      createdAt: new Date(now.getTime() - 90 * 24 * HOUR),
      onboardingStep: "completed",
    });
    const matchFingerprint = vi.fn(() => "SUMMER3M");
    const res = await claimDeferredPromoForUser({
      userId: "u1",
      explicitCode: null,
      matchFingerprint,
      now,
    });
    expect(res).toEqual({ status: "not-eligible" });
    expect(matchFingerprint).not.toHaveBeenCalled();
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });

  it("ignores a typed code while the manual-entry seam is off, and uses the fingerprint", async () => {
    h.userFindUnique.mockResolvedValueOnce(freshAccount);
    h.promoFindUnique.mockResolvedValueOnce(code({ code: "LANDING" }));
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    const res = await claimDeferredPromoForUser({
      userId: "u1",
      explicitCode: "PUBLIC50",
      matchFingerprint: () => "LANDING",
      now,
    });
    expect(h.promoFindUnique).toHaveBeenCalledWith({ where: { code: "LANDING" } });
    expect(res).toMatchObject({ status: "claimed", result: { applied: true } });
  });

  it("answers no-code when only a typed code was sent and the seam is off", async () => {
    h.userFindUnique.mockResolvedValueOnce(freshAccount);
    const res = await claimDeferredPromoForUser({
      userId: "u1",
      explicitCode: "PUBLIC50",
      matchFingerprint: () => null,
      now,
    });
    expect(res).toEqual({ status: "no-code" });
    expect(h.promoFindUnique).not.toHaveBeenCalled();
  });

  it("honours a typed code once PROMO_MANUAL_ENTRY_ENABLED is on", async () => {
    h.env.PROMO_MANUAL_ENTRY_ENABLED = true;
    h.userFindUnique.mockResolvedValueOnce(freshAccount);
    h.promoFindUnique.mockResolvedValueOnce(code({ code: "PUBLIC50" }));
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    const matchFingerprint = vi.fn(() => "LANDING");
    const res = await claimDeferredPromoForUser({
      userId: "u1",
      explicitCode: "PUBLIC50",
      matchFingerprint,
      now,
    });
    expect(res).toMatchObject({ status: "claimed" });
    expect(h.promoFindUnique).toHaveBeenCalledWith({ where: { code: "PUBLIC50" } });
    expect(matchFingerprint).not.toHaveBeenCalled();
  });
});
