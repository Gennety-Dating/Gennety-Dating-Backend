import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WishlistLookupResult } from "./wishlist-lookup.js";

/**
 * The chat agent's wishlist card (decision journal 2026-10-15): the tool only
 * builds a card, the tap saves. Every dependency is injected — no database,
 * no Storage, no web.
 */

vi.mock("../config.js", () => ({ env: { SUPABASE_CHAT_BUCKET: "chat-attachments" } }));
vi.mock("@gennety/db", () => ({ prisma: {} }));
const deleteStorageObject = vi.fn(async (_bucket: string, _path: string) => true);
const createChatImageSignedUrls = vi.fn(async (paths: readonly string[]) =>
  paths.map((path) => (path ? `https://signed/${path}` : null)),
);
vi.mock("./storage.js", () => ({
  createChatImageSignedUrls: (paths: readonly string[], _ttl: number) => createChatImageSignedUrls(paths),
  deleteStorageObject: (bucket: string, path: string) => deleteStorageObject(bucket, path),
  downloadChatImage: async () => null,
  uploadWishlistImage: async () => ({ path: "x" }),
}));
vi.mock("./wishlist-lookup.js", () => ({ lookupWishlistEntry: async () => ({ ok: false, error: "unavailable" }) }));
vi.mock("./wishlist.js", () => ({ addWishlistItems: async () => ({ ok: true, items: [] }) }));

const {
  proposeWishlistItems,
  readWishlistCard,
  resolveWishlistCard,
  wishlistCardNote,
  wishlistCardViews,
  wishlistIdentity,
} = await import("./chat-wishlist.js");
type WishlistCard = import("./chat-wishlist.js").WishlistCard;
type ResolveDeps = import("./chat-wishlist.js").ResolveDeps;

const USER = "11111111-1111-4111-8111-111111111111";
const PHOTO_1 = `${USER}/1700000000001.jpg`;
const PHOTO_2 = `${USER}/1700000000002.jpg`;

const ctx = {
  userId: USER,
  language: "ru" as const,
  cityKey: "ua:kyiv",
  visiblePhotos: new Set([PHOTO_1, PHOTO_2]),
  buttonLabel: "Добавить",
};

function candidate(over: Record<string, unknown> = {}) {
  return {
    candidateId: "c1",
    title: "Santal 33",
    brand: "Le Labo",
    category: "perfume",
    productUrl: "https://shop.example/santal-33",
    imageUrl: "https://cdn.example/santal.jpg",
    priceBand: "€€€",
    description: null,
    source: "search",
    ...over,
  };
}

function deps(over: { existing?: Array<{ title: string; brand: string | null }>; lookup?: () => Promise<WishlistLookupResult> } = {}) {
  const lookup = vi.fn(over.lookup ?? (async (): Promise<WishlistLookupResult> => ({ ok: true, candidates: [candidate() as never] })));
  return {
    lookup,
    existingItems: vi.fn(async () => over.existing ?? []),
  };
}

function parsedResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

describe("proposeWishlistItems", () => {
  it("builds one card from a set of photos: their own photo, no look-up", async () => {
    const d = deps();
    const out = await proposeWishlistItems(
      {
        items: [
          { title: "Baccarat Rouge 540", brand: "Maison Francis Kurkdjian", category: "perfume", note: "самый любимый", photo: PHOTO_1, image: "photo" },
          { title: "Lost Cherry", brand: "Tom Ford", category: "perfume", photo: PHOTO_2, image: "photo" },
        ],
      },
      ctx,
      d,
    );

    expect(d.lookup).not.toHaveBeenCalled();
    expect(out.card?.state).toBe("open");
    expect(out.card?.items).toMatchObject([
      { key: "i1", title: "Baccarat Rouge 540", photoPath: PHOTO_1, note: "самый любимый", source: "text" },
      { key: "i2", title: "Lost Cherry", photoPath: PHOTO_2 },
    ]);
    expect(parsedResult(out.result)).toMatchObject({ success: true, card: "shown" });
  });

  it("never takes a photo the model was not shown in this chat", async () => {
    const out = await proposeWishlistItems(
      { items: [{ title: "Lost Cherry", category: "perfume", photo: "22222222-2222-4222-8222-222222222222/1.jpg", image: "photo" }] },
      ctx,
      deps(),
    );
    expect(out.card?.items[0]?.photoPath).toBeNull();
  });

  it("reads a link for its page photo and name", async () => {
    const d = deps({ lookup: async () => ({ ok: true, candidates: [candidate({ title: "Santal 33 EDP", source: "link" }) as never] }) });
    const out = await proposeWishlistItems(
      { items: [{ title: "духи", category: "gift", link: "http://shop.example/santal-33", image: "none" }] },
      ctx,
      d,
    );

    expect(d.lookup).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "url", value: "https://shop.example/santal-33", timeoutMs: 12_000 }),
    );
    expect(out.card?.items[0]).toMatchObject({
      title: "Santal 33 EDP",
      brand: "Le Labo",
      category: "perfume",
      remoteImageUrl: "https://cdn.example/santal.jpg",
      productUrl: "https://shop.example/santal-33",
      source: "link",
    });
  });

  it("finds a clean picture for a screenshot but keeps the name it read", async () => {
    const d = deps({ lookup: async () => ({ ok: true, candidates: [candidate({ title: "Santal 33 Body Lotion" }) as never] }) });
    const out = await proposeWishlistItems(
      { items: [{ title: "Santal 33", brand: "Le Labo", category: "perfume", photo: PHOTO_1, image: "find" }] },
      ctx,
      d,
    );

    expect(d.lookup).toHaveBeenCalledWith(expect.objectContaining({ kind: "query", value: "Le Labo Santal 33" }));
    expect(out.card?.items[0]).toMatchObject({
      title: "Santal 33",
      photoPath: null,
      remoteImageUrl: "https://cdn.example/santal.jpg",
      source: "search",
    });
  });

  it("falls back to their photo when the look-up finds nothing", async () => {
    const out = await proposeWishlistItems(
      { items: [{ title: "Santal 33", brand: "Le Labo", category: "perfume", photo: PHOTO_1, image: "find" }] },
      ctx,
      deps({ lookup: async () => ({ ok: false, error: "timeout" }) }),
    );
    expect(out.card?.items[0]).toMatchObject({ photoPath: PHOTO_1, remoteImageUrl: null, source: "text" });
  });

  it("runs at most four look-ups per card", async () => {
    const d = deps();
    await proposeWishlistItems(
      { items: Array.from({ length: 6 }, (_, i) => ({ title: `Духи ${i}`, category: "perfume", image: "find" })) },
      ctx,
      d,
    );
    expect(d.lookup).toHaveBeenCalledTimes(4);
  });

  it("leaves out what is already in the wishlist and says so", async () => {
    const out = await proposeWishlistItems(
      {
        items: [
          { title: "Santal 33", brand: "Le Labo", category: "perfume", image: "none" },
          { title: "Lost Cherry", brand: "Tom Ford", category: "perfume", image: "none" },
        ],
      },
      ctx,
      deps({ existing: [{ title: "Le Labo Santal 33", brand: null }] }),
    );
    expect(out.card?.items.map((item) => item.title)).toEqual(["Lost Cherry"]);
    expect(parsedResult(out.result)).toMatchObject({ alreadyInWishlist: ["Santal 33"] });
  });

  it("shows no card when everything is already there", async () => {
    const out = await proposeWishlistItems(
      { items: [{ title: "Santal 33", brand: "Le Labo", category: "perfume", image: "none" }] },
      ctx,
      deps({ existing: [{ title: "Santal 33", brand: "Le Labo" }] }),
    );
    expect(out.card).toBeNull();
    expect(parsedResult(out.result)).toMatchObject({ success: false, error: "already_in_wishlist" });
  });

  it("a full list gets no card but a button to «Мой вишлист»", async () => {
    const existing = Array.from({ length: 30 }, (_, i) => ({ title: `item ${i}`, brand: null }));
    const out = await proposeWishlistItems(
      { items: [{ title: "Lost Cherry", category: "perfume", image: "none" }] },
      ctx,
      deps({ existing }),
    );
    expect(out.card).toBeNull();
    expect(out.openWishlist).toBe(true);
    expect(parsedResult(out.result)).toMatchObject({ error: "wishlist_full" });
  });

  it("trims a card to the room left", async () => {
    const existing = Array.from({ length: 29 }, (_, i) => ({ title: `item ${i}`, brand: null }));
    const out = await proposeWishlistItems(
      {
        items: [
          { title: "A", category: "gift", image: "none" },
          { title: "B", category: "gift", image: "none" },
        ],
      },
      ctx,
      deps({ existing }),
    );
    expect(out.card?.items).toHaveLength(1);
    expect(parsedResult(out.result)).toMatchObject({ leftOutNoRoom: 1 });
  });

  // Live evals 2026-10-15: «да, добавь» in words made a second copy of the card.
  it("items still on an unanswered card get no second card, but a pointer to its button", async () => {
    const out = await proposeWishlistItems(
      { items: [{ title: "Пионы", category: "flowers", image: "find" }] },
      { ...ctx, openCardItems: new Set([wishlistIdentity("Пионы", null)]) },
      deps(),
    );
    expect(out.card).toBeNull();
    const result = parsedResult(out.result);
    expect(result).toMatchObject({ success: false, error: "card_already_open" });
    expect(String(result.instruction)).toContain("«Добавить»");
  });

  it("names the button in their language", async () => {
    const out = await proposeWishlistItems({ items: [{ title: "Пионы", category: "flowers", image: "none" }] }, ctx, deps());
    expect(String(parsedResult(out.result).instruction)).toContain("«Добавить» button");
  });

  it("refuses arguments without a single titled item", async () => {
    const out = await proposeWishlistItems({ items: [{ category: "gift" }] }, ctx, deps());
    expect(out.card).toBeNull();
    expect(parsedResult(out.result)).toMatchObject({ error: "no_items" });
  });
});

describe("wishlistIdentity", () => {
  it("treats the brand inside the title as the same bottle", () => {
    expect(wishlistIdentity("Le Labo Santal 33", null)).toBe(wishlistIdentity("Santal 33", "Le Labo"));
    expect(wishlistIdentity("Santal-33!", "LE LABO")).toBe(wishlistIdentity("santal 33", "le labo"));
  });
});

function storedCard(over: Partial<WishlistCard> = {}): WishlistCard {
  return {
    kind: "wishlist_proposal",
    state: "open",
    items: [
      { key: "i1", title: "Baccarat Rouge 540", brand: "MFK", category: "perfume", note: null, photoPath: PHOTO_1, remoteImageUrl: null, productUrl: null, priceBand: null, source: "text" },
      { key: "i2", title: "Santal 33", brand: "Le Labo", category: "perfume", note: null, photoPath: null, remoteImageUrl: "https://cdn.example/santal.jpg", productUrl: "https://shop.example/s", priceBand: "€€€", source: "search" },
    ],
    savedKeys: [],
    resolvedAt: null,
    ...over,
  };
}

describe("reading and showing a stored card", () => {
  it("reads only a wishlist card", () => {
    expect(readWishlistCard(null)).toBeNull();
    expect(readWishlistCard({ kind: "inbox_item" })).toBeNull();
    expect(readWishlistCard(storedCard())?.items).toHaveLength(2);
  });

  it("signs their photo and passes the shop photo through", async () => {
    const [view] = await wishlistCardViews([storedCard({ state: "saved", savedKeys: ["i2"] })]);
    expect(view).toMatchObject({
      state: "saved",
      savedCount: 1,
      items: [
        { key: "i1", imageUrl: `https://signed/${PHOTO_1}`, saved: false },
        { key: "i2", imageUrl: "https://cdn.example/santal.jpg", saved: true },
      ],
    });
  });

  it("tells the next turn what happened to the card", () => {
    expect(wishlistCardNote(storedCard())).toContain("Not tapped yet");
    expect(wishlistCardNote(storedCard({ state: "dismissed" }))).toContain("nothing saved");
    const saved = wishlistCardNote(storedCard({ state: "saved", savedKeys: ["i1"] }));
    expect(saved).toContain("saved to their wishlist: «MFK Baccarat Rouge 540»");
    expect(saved).toContain("left out: «Le Labo Santal 33»");
  });
});

describe("resolveWishlistCard", () => {
  let stored: WishlistCard | null;
  let d: ResolveDeps & {
    addItems: ReturnType<typeof vi.fn>;
    copyChatPhoto: ReturnType<typeof vi.fn>;
    saveCard: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    stored = storedCard();
    deleteStorageObject.mockClear();
    d = {
      findRow: vi.fn(async () => (stored ? { attachment: stored } : null)),
      saveCard: vi.fn(async (_id: string, card: WishlistCard) => {
        stored = card;
      }),
      countItems: vi.fn(async () => 0),
      existingItems: vi.fn(async () => []),
      copyChatPhoto: vi.fn(async () => `${USER}/w1700000000003-abcdef.jpg`),
      addItems: vi.fn(async () => ({ ok: true as const, items: [] })),
    };
  });

  it("saves the ticked items, their photo copied, the shop photo to be copied", async () => {
    const out = await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1", "i2"] }, d);

    expect(out).toMatchObject({ ok: true, card: { state: "saved", savedKeys: ["i1", "i2"] } });
    expect(d.copyChatPhoto).toHaveBeenCalledWith(USER, PHOTO_1);
    expect(d.addItems).toHaveBeenCalledWith(
      USER,
      [
        expect.objectContaining({ title: "Baccarat Rouge 540", imagePath: `${USER}/w1700000000003-abcdef.jpg`, imageUrl: null, source: "text" }),
        expect.objectContaining({ title: "Santal 33", imagePath: null, imageUrl: "https://cdn.example/santal.jpg", source: "search" }),
      ],
      expect.any(Date),
    );
  });

  it("saves only what is left ticked", async () => {
    await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i2"] }, d);
    expect(d.addItems.mock.calls[0]![1]).toHaveLength(1);
    expect(stored?.savedKeys).toEqual(["i2"]);
  });

  it("a second «Add» answers the saved card and writes nothing", async () => {
    await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d);
    await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d);
    expect(d.addItems).toHaveBeenCalledTimes(1);
  });

  it("a double tap saves once", async () => {
    await Promise.all([
      resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d),
      resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d),
    ]);
    expect(d.addItems).toHaveBeenCalledTimes(1);
  });

  it("«Не надо» closes the card; «Add» after it is a change of mind", async () => {
    expect(await resolveWishlistCard(USER, "m1", { action: "dismiss" }, d)).toMatchObject({ ok: true, card: { state: "dismissed" } });
    expect(d.addItems).not.toHaveBeenCalled();
    expect(await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d)).toMatchObject({ ok: true, card: { state: "saved" } });
  });

  it("«Не надо» on a saved card changes nothing", async () => {
    await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d);
    expect(await resolveWishlistCard(USER, "m1", { action: "dismiss" }, d)).toMatchObject({ ok: true, card: { state: "saved" } });
  });

  it("an item saved meanwhile counts as saved and is stored once", async () => {
    d.existingItems = vi.fn(async () => [{ title: "Santal 33", brand: "Le Labo" }]);
    const out = await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1", "i2"] }, d);
    expect(d.addItems.mock.calls[0]![1]).toHaveLength(1);
    expect(out).toMatchObject({ ok: true, card: { savedKeys: ["i1", "i2"] } });
  });

  it("a full list is a refusal with the room left, before any copy", async () => {
    d.existingItems = vi.fn(async () => Array.from({ length: 29 }, (_, i) => ({ title: `x${i}`, brand: null })));
    const out = await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1", "i2"] }, d);
    expect(out).toEqual({ ok: false, error: "too-many", room: 1 });
    expect(d.copyChatPhoto).not.toHaveBeenCalled();
    expect(stored?.state).toBe("open");
  });

  it("a refused insert removes the copies it made", async () => {
    d.addItems = vi.fn(async () => ({ ok: false as const, error: "bad-item" as const }));
    const out = await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d);
    expect(out).toEqual({ ok: false, error: "unavailable" });
    expect(deleteStorageObject).toHaveBeenCalledWith("chat-attachments", `${USER}/w1700000000003-abcdef.jpg`);
  });

  it("a photo that cannot be copied leaves the item without one, not unsaved", async () => {
    d.copyChatPhoto = vi.fn(async () => null);
    const out = await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d);
    expect(out.ok).toBe(true);
    expect(d.addItems.mock.calls[0]![1][0]).toMatchObject({ imagePath: null, imageUrl: null });
  });

  it("unknown keys, someone else's message or a row without a card", async () => {
    expect(await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i9"] }, d)).toEqual({ ok: false, error: "bad-request" });
    stored = null;
    expect(await resolveWishlistCard(USER, "m1", { action: "save", keys: ["i1"] }, d)).toEqual({ ok: false, error: "not-found" });
  });
});
