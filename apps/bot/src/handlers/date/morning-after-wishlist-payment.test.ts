import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const unlockFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    wishlistUnlock: { findUnique: unlockFindUnique },
  },
}));
vi.mock("../../config.js", () => ({ env: {} }));
vi.mock("../../services/morning-after.js", () => ({
  announceMutual: vi.fn(),
  recordMorningAfter: vi.fn(),
}));
const wishlistPurchasable = vi.fn();
const recordWishlistUnlock = vi.fn();
const mutualOfferFor = vi.fn();
vi.mock("../../services/wishlist.js", () => ({
  wishlistPurchasable,
  recordWishlistUnlock,
  mutualOfferFor,
}));
vi.mock("../../services/founder-notify.js", () => ({
  notifyFounderPurchase: vi.fn().mockResolvedValue(undefined),
}));

const { buildWishInvoicePayload } = await import("@gennety/shared");
const { settleWishlistStarsPayment } = await import("./morning-after.js");

const MATCH = "11111111-2222-4333-8444-555555555555";

function api() {
  return {
    refundStarPayment: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ id: "viewer-1", language: "en", telegramId: 77n });
  unlockFindUnique.mockResolvedValue(null);
  wishlistPurchasable.mockResolvedValue({ ok: true, ownerId: "owner-1" });
  recordWishlistUnlock.mockResolvedValue("created");
  mutualOfferFor.mockResolvedValue({ ok: false });
});

describe("settleWishlistStarsPayment", () => {
  it("answers a redelivered charge from its own row — never refunds a delivered sheet", async () => {
    // The first delivery recorded the unlock; the sheet now reads `already-unlocked`.
    unlockFindUnique.mockResolvedValue({ matchId: MATCH, userId: "viewer-1" });
    wishlistPurchasable.mockResolvedValue({ ok: false, error: "already-unlocked" });
    const a = api();

    const result = await settleWishlistStarsPayment(a, 77, buildWishInvoicePayload(MATCH), "charge-1", 150);

    expect(result).toEqual({ ok: true });
    expect(a.refundStarPayment).not.toHaveBeenCalled();
    expect(recordWishlistUnlock).not.toHaveBeenCalled();
  });

  it("refunds a second charge that lost the sheet to a parallel one", async () => {
    recordWishlistUnlock.mockResolvedValue("taken");
    const a = api();

    const result = await settleWishlistStarsPayment(a, 77, buildWishInvoicePayload(MATCH), "charge-2", 150);

    expect(result).toMatchObject({ ok: false, compensated: true });
    expect(a.refundStarPayment).toHaveBeenCalledWith(77, "charge-2");
  });

  it("counts an already-refunded charge as given back", async () => {
    wishlistPurchasable.mockResolvedValue({ ok: false, error: "no-sheet" });
    const a = api();
    a.refundStarPayment.mockRejectedValue(new Error("Bad Request: CHARGE_ALREADY_REFUNDED"));

    const result = await settleWishlistStarsPayment(a, 77, buildWishInvoicePayload(MATCH), "charge-3", 150);

    expect(result).toMatchObject({ ok: false, compensated: true });
  });
});
