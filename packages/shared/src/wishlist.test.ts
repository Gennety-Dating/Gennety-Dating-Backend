import { describe, expect, it } from "vitest";
import {
  AFTER_DATE_KEYS,
  AFTER_DATE_TABLES,
  afterDateGendered,
  wishlistMoreLabel,
} from "./after-date-i18n.js";
import {
  buildWishInvoicePayload,
  parseWishInvoicePayload,
} from "./stars.js";
import {
  isMorningAfterAnswer,
  wishlistPriceBandFor,
  wishlistTeaserCount,
  wishlistTeaserIds,
} from "./wishlist.js";

describe("wishlist teaser", () => {
  it("frees about a tenth, at least one, and nothing for tiny lists", () => {
    expect(wishlistTeaserCount(0)).toBe(0);
    expect(wishlistTeaserCount(2)).toBe(0);
    expect(wishlistTeaserCount(3)).toBe(1);
    expect(wishlistTeaserCount(9)).toBe(1);
    expect(wishlistTeaserCount(20)).toBe(2);
  });

  it("prefers a place, a drink or flowers as the free item", () => {
    const items = [
      { id: "a", category: "perfume" },
      { id: "b", category: "fashion" },
      { id: "c", category: "drink" },
      { id: "d", category: "gift" },
    ];
    expect(wishlistTeaserIds(items)).toEqual(["c"]);
  });

  it("falls back to the head of the list", () => {
    const items = [
      { id: "a", category: "perfume" },
      { id: "b", category: "fashion" },
      { id: "c", category: "gift" },
    ];
    expect(wishlistTeaserIds(items)).toEqual(["a"]);
  });
});

describe("price bands", () => {
  it("maps euros to a band and refuses nonsense", () => {
    expect(wishlistPriceBandFor(12)).toBe("€");
    expect(wishlistPriceBandFor(85)).toBe("€€");
    expect(wishlistPriceBandFor(250)).toBe("€€€");
    expect(wishlistPriceBandFor(7000)).toBe("€€€€");
    expect(wishlistPriceBandFor(0)).toBeNull();
    expect(wishlistPriceBandFor(Number.NaN)).toBeNull();
  });
});

describe("morning-after answers", () => {
  it("accepts great / pass only", () => {
    expect(isMorningAfterAnswer("great")).toBe(true);
    expect(isMorningAfterAnswer("pass")).toBe(true);
    expect(isMorningAfterAnswer("maybe")).toBe(false);
    expect(isMorningAfterAnswer("toString")).toBe(false);
  });
});

describe("wish invoice payload", () => {
  it("round-trips a match id and refuses foreign payloads", () => {
    const id = "0b9a1f3e-7c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(parseWishInvoicePayload(buildWishInvoicePayload(id))).toEqual({ matchId: id });
    expect(parseWishInvoicePayload(`prime:${id}`)).toBeNull();
    expect(parseWishInvoicePayload("wish:not-a-uuid")).toBeNull();
  });
});

describe("after-date copy", () => {
  it("has every key in every language, non-empty", () => {
    for (const [lang, table] of Object.entries(AFTER_DATE_TABLES)) {
      for (const key of AFTER_DATE_KEYS) {
        expect(table[key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it("pushes name nobody (the lock screen is public)", () => {
    for (const table of Object.values(AFTER_DATE_TABLES)) {
      for (const key of [
        "morningAfterPushTitle",
        "morningAfterPushBody",
        "mutualPushTitle",
        "mutualPushBody",
        "wishlistSessionPushTitle",
        "wishlistSessionPushBody",
      ] as const) {
        expect(table[key]).not.toContain("{name}");
      }
    }
  });

  it("carries no invented statistics", () => {
    for (const table of Object.values(AFTER_DATE_TABLES)) {
      expect(`${table.mutualTiming} ${table.mutualGift}`).not.toMatch(/\d+\s?%/u);
    }
  });

  it("agrees verbs with the partner's gender", () => {
    expect(afterDateGendered("ru", "mutualBody", "female", { name: "Анна" })).toBe(
      "Анна тоже отлично провела время.",
    );
    expect(afterDateGendered("ru", "mutualBody", "male", { name: "Олег" })).toBe(
      "Олег тоже отлично провёл время.",
    );
  });

  it("pluralises «Ещё N позиций»", () => {
    expect(wishlistMoreLabel("ru", 1)).toBe("Ещё 1 позиция");
    expect(wishlistMoreLabel("ru", 3)).toBe("Ещё 3 позиции");
    expect(wishlistMoreLabel("ru", 5)).toBe("Ещё 5 позиций");
    expect(wishlistMoreLabel("en", 7)).toBe("7 more items");
  });
});
