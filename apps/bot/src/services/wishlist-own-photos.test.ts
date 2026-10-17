import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wishlist's own photos (decision journal 2026-10-15): a photo already in
 * the owner's wishlist key is stored as is (the chat card copies the person's
 * chat photo there), and removing an item removes its photo.
 */

vi.mock("../config.js", () => ({ env: { SUPABASE_CHAT_BUCKET: "chat-attachments", WISHLIST_FEATURE_ENABLED: true, MORNING_AFTER_ENABLED: false } }));

const createMany = vi.fn(async (_a: unknown) => ({ count: 1 }));
const findFirst = vi.fn(async (_a: unknown): Promise<unknown> => null);
const deleteMany = vi.fn(async (_a: unknown) => ({ count: 1 }));
vi.mock("@gennety/db", () => ({
  prisma: {
    wishlistItem: {
      count: async () => 0,
      createMany: (a: unknown) => createMany(a),
      findMany: async () => [],
      findFirst: (a: unknown) => findFirst(a),
      deleteMany: (a: unknown) => deleteMany(a),
    },
    user: { update: async () => ({}) },
  },
}));
const deleteStorageObject = vi.fn(async (_b: string, _p: string) => true);
vi.mock("./storage.js", () => ({
  createProfilePhotoSignedUrl: async () => null,
  createWishlistImageSignedUrls: async (paths: string[]) => paths.map(() => null),
  deleteStorageObject: (b: string, p: string) => deleteStorageObject(b, p),
}));
const copyWishlistImage = vi.fn(async (_u: string, _url: string) => "copied/path.jpg");
vi.mock("./wishlist-lookup.js", () => ({ copyWishlistImage: (u: string, url: string) => copyWishlistImage(u, url) }));
vi.mock("./premium.js", () => ({ isPremiumActive: () => false }));
vi.mock("./ticket-wallet.js", () => ({ isUniqueViolation: () => false }));

const { addWishlistItems, deleteWishlistItem, ownWishlistImagePath, wishlistSheetLive } = await import("./wishlist.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OWN = `${USER}/w1700000000000-abcdef.jpg`;

beforeEach(() => {
  createMany.mockClear();
  copyWishlistImage.mockClear();
  deleteStorageObject.mockClear();
});

describe("ownWishlistImagePath", () => {
  it("accepts only the owner's own wishlist key", () => {
    expect(ownWishlistImagePath(USER, OWN)).toBe(OWN);
    expect(ownWishlistImagePath(USER, `${USER}/1700000000000.jpg`)).toBeNull(); // a chat key
    expect(ownWishlistImagePath(USER, `22222222-2222-4222-8222-222222222222/w1-abcdef.jpg`)).toBeNull();
    expect(ownWishlistImagePath(USER, `${USER}/../x/w1-abcdef.jpg`)).toBeNull();
    expect(ownWishlistImagePath(USER, 42)).toBeNull();
  });
});

describe("addWishlistItems", () => {
  it("stores an own photo as is and copies nothing", async () => {
    await addWishlistItems(USER, [{ category: "perfume", title: "Lost Cherry", source: "text", imagePath: OWN }]);
    expect(copyWishlistImage).not.toHaveBeenCalled();
    expect(createMany.mock.calls[0]![0]).toMatchObject({ data: [{ imageUrl: OWN, source: "text" }] });
  });

  it("ignores someone else's key and copies the remote photo instead", async () => {
    await addWishlistItems(USER, [
      {
        category: "perfume",
        title: "Lost Cherry",
        source: "search",
        imagePath: "22222222-2222-4222-8222-222222222222/w1-abcdef.jpg",
        imageUrl: "https://cdn.example/a.jpg",
      },
    ]);
    expect(copyWishlistImage).toHaveBeenCalledWith(USER, "https://cdn.example/a.jpg");
    expect(createMany.mock.calls[0]![0]).toMatchObject({ data: [{ imageUrl: "copied/path.jpg" }] });
  });
});

describe("deleteWishlistItem", () => {
  it("removes the item's own photo with it", async () => {
    findFirst.mockResolvedValueOnce({ imageUrl: OWN });
    expect(await deleteWishlistItem(USER, "item-1")).toBe(true);
    await vi.waitFor(() => expect(deleteStorageObject).toHaveBeenCalledWith("chat-attachments", OWN));
  });

  it("an item that is not theirs deletes nothing", async () => {
    deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await deleteWishlistItem(USER, "item-2")).toBe(false);
    expect(deleteStorageObject).not.toHaveBeenCalled();
  });
});

describe("wishlistSheetLive", () => {
  it("the wishlist flag alone collects but shows nothing", () => {
    expect(wishlistSheetLive()).toBe(false);
  });
});
