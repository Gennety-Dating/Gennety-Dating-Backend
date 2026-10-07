import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "./types.js";
import {
  WISHLIST_CATEGORIES,
  WISHLIST_TITLE_MAX_LEN,
  isWishlistCategory,
  isWishlistPriceBand,
} from "./wishlist.js";
import { WISHLIST_CATALOG, wishlistCatalogFor, wishlistCatalogItem } from "./wishlist-catalog.js";

describe("WISHLIST_CATALOG", () => {
  it("has unique, slug-shaped keys", () => {
    const keys = WISHLIST_CATALOG.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key, key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  });

  it("titles every item in every supported language, within the title cap", () => {
    for (const item of WISHLIST_CATALOG) {
      expect(Object.keys(item.title).sort(), item.key).toEqual([...SUPPORTED_LANGUAGES].sort());
      for (const language of SUPPORTED_LANGUAGES) {
        const title = item.title[language];
        expect(title.trim(), `${item.key}/${language}`).toBe(title);
        expect(title.length, `${item.key}/${language}`).toBeGreaterThan(0);
        expect(title.length, `${item.key}/${language}`).toBeLessThanOrEqual(WISHLIST_TITLE_MAX_LEN);
      }
    }
  });

  it("never repeats the brand inside a title (the card shows both)", () => {
    for (const item of WISHLIST_CATALOG) {
      if (!item.brand) continue;
      for (const language of SUPPORTED_LANGUAGES) {
        expect(
          item.title[language].toLowerCase().startsWith(item.brand.toLowerCase()),
          `${item.key}/${language}`,
        ).toBe(false);
      }
    }
  });

  it("uses only valid categories and price bands", () => {
    for (const item of WISHLIST_CATALOG) {
      expect(isWishlistCategory(item.category), item.key).toBe(true);
      expect(isWishlistPriceBand(item.priceBand), item.key).toBe(true);
      expect(["female", "male", "any"], item.key).toContain(item.audience);
    }
  });

  it("gives a generic item a bundled image and a brand item a search query", () => {
    for (const item of WISHLIST_CATALOG) {
      if (item.brand) {
        expect(item.image, item.key).toBeNull();
        expect(item.query?.trim().length ?? 0, item.key).toBeGreaterThan(0);
      } else {
        expect(item.query, item.key).toBeNull();
        expect(item.image, item.key).toMatch(/^(?:vibe-option|wishlist)-[a-z0-9-]+$/u);
      }
    }
  });

  it("has lower-case tags", () => {
    for (const item of WISHLIST_CATALOG) {
      expect(item.tags.length, item.key).toBeGreaterThan(0);
      for (const tag of item.tags) expect(tag, item.key).toMatch(/^[a-z][a-z-]*$/u);
    }
  });

  it("covers every category", () => {
    const covered = new Set(WISHLIST_CATALOG.map((item) => item.category));
    for (const category of WISHLIST_CATEGORIES) expect(covered.has(category), category).toBe(true);
  });
});

describe("wishlistCatalogFor", () => {
  it("shows an audience its own items plus the neutral ones, never the other set", () => {
    const female = wishlistCatalogFor("female");
    const male = wishlistCatalogFor("male");
    expect(female.every((item) => item.audience !== "male")).toBe(true);
    expect(male.every((item) => item.audience !== "female")).toBe(true);
    expect(female.some((item) => item.audience === "any")).toBe(true);
    expect(male.some((item) => item.audience === "any")).toBe(true);
    expect(female.length).toBeGreaterThanOrEqual(35);
    expect(male.length).toBeLessThan(female.length);
  });

  it("orders by WISHLIST_CATEGORIES", () => {
    for (const audience of ["female", "male"] as const) {
      const ranks = wishlistCatalogFor(audience).map((item) =>
        WISHLIST_CATEGORIES.indexOf(item.category),
      );
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});

describe("wishlistCatalogItem", () => {
  it("finds an item by key and answers null for an unknown one", () => {
    expect(wishlistCatalogItem("peonies")?.image).toBe("vibe-option-peony");
    expect(wishlistCatalogItem("nope")).toBeNull();
  });
});
