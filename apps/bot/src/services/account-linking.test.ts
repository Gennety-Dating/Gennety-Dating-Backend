import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUnique, del, update, transaction } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  del: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => transaction(fn),
    user: { findUnique, delete: del, update },
  },
}));

import {
  adoptAccountByPhone,
  classifyPhoneConflict,
  hasRealAccountData,
  type AccountLinkUser,
} from "./account-linking.js";

function makeUser(overrides: Partial<AccountLinkUser> = {}): AccountLinkUser {
  return {
    id: "stub-id",
    telegramId: 111n,
    telegramUsername: null,
    platform: "telegram",
    phone: null,
    phoneVerifiedAt: null,
    registrationTrack: "general",
    referralSource: null,
    onboardingStep: "language",
    status: "onboarding",
    language: "ru",
    isEmailVerified: false,
    ticketBalance: 0,
    premiumUntil: null,
    promoRedeemedAt: null,
    profile: { photos: [] },
    _count: { matchesAsA: 0, matchesAsB: 0 },
    ...overrides,
  } as AccountLinkUser;
}

const owner = makeUser({
  id: "owner-id",
  telegramId: -158504734448542n,
  platform: "mobile",
  phone: "+380972455081",
  phoneVerifiedAt: new Date("2026-07-19T02:00:00Z"),
  onboardingStep: "completed",
  status: "onboarding",
});

describe("hasRealAccountData", () => {
  it("treats a fresh, unfinished registration as disposable", () => {
    expect(hasRealAccountData(makeUser())).toBe(false);
  });

  it.each([
    ["finished onboarding", { onboardingStep: "completed" as const }],
    ["left the onboarding status", { status: "active" as const }],
    ["a verified email", { isEmailVerified: true }],
    ["profile photos", { profile: { photos: ["file-id"] } }],
    ["a match", { _count: { matchesAsA: 1, matchesAsB: 0 } }],
    ["a ticket balance", { ticketBalance: 2 }],
    ["a premium entitlement", { premiumUntil: new Date() }],
    ["a redeemed promo", { promoRedeemedAt: new Date() }],
  ])("protects a row with %s", (_label, overrides) => {
    expect(hasRealAccountData(makeUser(overrides as Partial<AccountLinkUser>))).toBe(
      true,
    );
  });
});

describe("classifyPhoneConflict", () => {
  it("is a no-op when the number already belongs to this very row", () => {
    const same = makeUser({ id: "owner-id" });
    expect(classifyPhoneConflict(same, owner)).toEqual({ kind: "same" });
  });

  it("adopts the owner when the current row is an empty registration", () => {
    expect(classifyPhoneConflict(makeUser(), owner)).toEqual({
      kind: "adopt",
      ownerId: "owner-id",
      stubId: "stub-id",
    });
  });

  it("adopts a previous REAL Telegram account (number moved to a new one)", () => {
    const previousTelegram = makeUser({
      id: "owner-id",
      telegramId: 999n,
      platform: "telegram",
      phone: "+380972455081",
      onboardingStep: "completed",
      status: "active",
      profile: { photos: ["a", "b", "c", "d"] },
    });
    expect(classifyPhoneConflict(makeUser(), previousTelegram)).toEqual({
      kind: "adopt",
      ownerId: "owner-id",
      stubId: "stub-id",
    });
  });

  it("routes to support when BOTH rows carry real data", () => {
    const populatedCurrent = makeUser({ onboardingStep: "completed" });
    expect(classifyPhoneConflict(populatedCurrent, owner)).toEqual({
      kind: "manual-merge",
    });
  });
});

describe("adoptAccountByPhone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ user: { findUnique, delete: del, update } }),
    );
  });

  const params = {
    ownerId: "owner-id",
    stubId: "stub-id",
    telegramId: 111n,
    phone: "+380972455081",
    telegramUsername: "ggen1e",
  };

  function resolveRows(ownerRow: AccountLinkUser, stubRow: AccountLinkUser | null) {
    findUnique.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === "owner-id" ? ownerRow : stubRow),
    );
  }

  it("deletes the empty row BEFORE handing its telegramId to the owner", async () => {
    resolveRows(owner, makeUser());
    update.mockResolvedValue(makeUser({ id: "owner-id", telegramId: 111n }));

    const result = await adoptAccountByPhone(params);

    expect(result.kind).toBe("adopted");
    expect(del).toHaveBeenCalledWith({ where: { id: "stub-id" } });
    // `telegramId` is @unique — the update would collide if it ran first.
    expect(del.mock.invocationCallOrder[0]!).toBeLessThan(
      update.mock.invocationCallOrder[0]!,
    );
  });

  it("carries the identity, upgrades a mobile row to both, and clears the pin", async () => {
    resolveRows(owner, makeUser({ referralSource: "promo:SUMMER3M" }));
    update.mockResolvedValue(makeUser({ id: "owner-id" }));

    await adoptAccountByPhone(params);

    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.telegramId).toBe(111n);
    expect(data.telegramUsername).toBe("ggen1e");
    expect(data.platform).toBe("both");
    // The pinned banner id points at a message in the OLD chat.
    expect(data.statusMessageId).toBeNull();
    // Attribution of the fresh touch survives the deleted row.
    expect(data.referralSource).toBe("promo:SUMMER3M");
  });

  it("keeps the owner's own attribution and platform when they already have them", async () => {
    const telegramOwner = makeUser({
      id: "owner-id",
      telegramId: 999n,
      platform: "telegram",
      phone: "+380972455081",
      referralSource: "tg:ig_story",
    });
    resolveRows(telegramOwner, makeUser({ referralSource: "promo:SUMMER3M" }));
    update.mockResolvedValue(telegramOwner);

    await adoptAccountByPhone(params);

    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect("platform" in data).toBe(false);
    expect("referralSource" in data).toBe(false);
  });

  it("bails out as stale when the empty row gained real data mid-flight", async () => {
    resolveRows(owner, makeUser({ onboardingStep: "completed" }));

    const result = await adoptAccountByPhone(params);

    expect(result).toEqual({ kind: "stale" });
    expect(del).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("bails out as stale when the owner no longer holds that number", async () => {
    resolveRows(makeUser({ id: "owner-id", phone: "+380990000000" }), makeUser());

    const result = await adoptAccountByPhone(params);

    expect(result).toEqual({ kind: "stale" });
    expect(del).not.toHaveBeenCalled();
  });

  it("bails out as stale when the empty row is gone", async () => {
    resolveRows(owner, null);

    expect(await adoptAccountByPhone(params)).toEqual({ kind: "stale" });
    expect(del).not.toHaveBeenCalled();
  });
});
