import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wishlist as a soft venue hint (decision journal 2026-10-15) — the
 * loader's gates: nothing is read while the hint or the feature is off, and a
 * hidden list never speaks.
 */

const env = { WISHLIST_FEATURE_ENABLED: true, WISHLIST_VENUE_HINT_WEIGHT: 0.3, SUPABASE_CHAT_BUCKET: "b" };
vi.mock("../config.js", () => ({ env }));
const findMany = vi.fn(async (_a: unknown): Promise<unknown[]> => [
  { userId: "a", category: "drink", title: "Негрони", brand: null, catalogKey: null },
  { userId: "b", category: "perfume", title: "Santal 33", brand: "Le Labo", catalogKey: null },
]);
vi.mock("@gennety/db", () => ({ prisma: { wishlistItem: { findMany: (a: unknown) => findMany(a) } } }));
vi.mock("./storage.js", () => ({}));
vi.mock("./wishlist-lookup.js", () => ({ copyWishlistImage: async () => null }));
vi.mock("./premium.js", () => ({ isPremiumActive: () => false }));
vi.mock("./ticket-wallet.js", () => ({ isUniqueViolation: () => false }));

const { loadWishlistVenueTastes } = await import("./wishlist.js");

beforeEach(() => {
  env.WISHLIST_FEATURE_ENABLED = true;
  env.WISHLIST_VENUE_HINT_WEIGHT = 0.3;
  findMany.mockClear();
});

describe("loadWishlistVenueTastes", () => {
  it("reads only venue-speaking items of lists that are not hidden, in one query", async () => {
    const tastes = await loadWishlistVenueTastes(["a", "b"]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        userId: { in: ["a", "b"] },
        category: { in: ["place", "drink", "experience"] },
        user: { wishlistHiddenAt: null },
      },
    });
    expect(tastes.get("a")?.experiences.has("drinks_evening")).toBe(true);
    // A perfume says nothing about a place.
    expect(tastes.has("b")).toBe(false);
  });

  it("reads nothing while the hint is off (the default)", async () => {
    env.WISHLIST_VENUE_HINT_WEIGHT = 0;
    expect((await loadWishlistVenueTastes(["a", "b"])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads nothing while the wishlist itself is off", async () => {
    env.WISHLIST_FEATURE_ENABLED = false;
    expect((await loadWishlistVenueTastes(["a", "b"])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
