import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    PROMO_FEATURE_ENABLED: true,
    PROMO_DEFAULT_TICKETS: 1,
    PROMO_DEFAULT_PREMIUM_MONTHS: 3,
  },
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  promoFindUnique: vi.fn(),
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
} = await import("./promo.js");

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
  h.env.PROMO_FEATURE_ENABLED = true;
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
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.userUpdateMany.mockResolvedValueOnce({ count: 1 });
    const res = await claimPromoCodeForUser("u1", "summer3m");
    expect(res.applied).toBe(true);
    expect(res.resolved?.code).toBe("SUMMER3M");
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", referralSource: null },
      data: { referralSource: "promo:SUMMER3M" },
    });
  });

  it("does not overwrite an existing attribution (first-touch)", async () => {
    h.promoFindUnique.mockResolvedValueOnce(code());
    h.userUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await claimPromoCodeForUser("u1", "SUMMER3M")).toMatchObject({
      applied: false,
      reason: "already-attributed",
    });
  });
});
