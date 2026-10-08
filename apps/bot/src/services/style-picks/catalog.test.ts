import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STYLE_SHORTLIST_SIZE } from "@gennety/shared";
import { catalogItemProblems, profileStyleTags, shortlistProducts, toCatalogItem, type StyleCatalogItem } from "./catalog.js";
import { digest, item } from "./__fixtures__/fixtures.js";

const SEED = resolve(import.meta.dirname, "../../../../../scripts/style-catalog.json");
const seed = JSON.parse(readFileSync(SEED, "utf8")) as unknown[];

describe("the committed seed catalog", () => {
  it("is valid item by item, with unique ids", () => {
    for (const entry of seed) expect(catalogItemProblems(entry), JSON.stringify(entry)).toEqual([]);
    const ids = seed.map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("holds the unverified belt inactive and the two added items", () => {
    const byId = new Map(seed.map((e) => [(e as { id: string }).id, e as StyleCatalogItem]));
    expect(byId.get("uniqlo-italian-leather-stitched-belt")!.active).toBe(false);
    expect(byId.get("parfums-de-marly-althair")).toMatchObject({ gender: "men", category: "scent", priceTier: 3 });
    expect(byId.get("matsuda-m3023")!.badges[0]).toMatchObject({ kind: "seenOn" });
  });

  it("badges only the five researched items", () => {
    const badged = seed
      .filter((e) => (e as StyleCatalogItem).badges.length > 0)
      .map((e) => (e as StyleCatalogItem).id)
      .sort();
    expect(badged).toEqual([
      "gisou-honey-infused-hair-oil",
      "jo-malone-wood-sage-sea-salt",
      "matsuda-m3023",
      "parfums-de-marly-althair",
      "the-ordinary-hyaluronic-acid-b5",
    ]);
  });

  it("gives every gender at least four active items per category", () => {
    const items = seed.map(toCatalogItem).filter((x): x is StyleCatalogItem => !!x);
    for (const gender of ["man", "woman"] as const) {
      const shortlist = shortlistProducts(items, digest({ gender }));
      for (const category of ["scent", "accents", "grooming"]) {
        expect(shortlist.filter((p) => p.category === category).length).toBeGreaterThanOrEqual(4);
      }
      expect(shortlist.length).toBeLessThanOrEqual(STYLE_SHORTLIST_SIZE);
    }
  });
});

describe("catalogItemProblems", () => {
  it("refuses unknown tags, http links and badges missing a language", () => {
    const bad = {
      ...item("x"),
      tags: ["sexy"],
      url: "http://shop.example/x",
      badges: [{ kind: "accolade", text: { en: "Award" }, sourceUrl: "https://a.example" }],
    };
    expect(catalogItemProblems(bad)).toEqual(
      expect.arrayContaining([
        "tags must be non-empty and from STYLE_TAGS",
        "url must be https",
        "badge text needs every language",
      ]),
    );
  });
});

describe("shortlistProducts", () => {
  const catalog = [
    item("men-scent", { gender: "men", tags: ["polished"] }),
    item("women-scent", { gender: "women", tags: ["polished", "calm"] }),
    item("unisex-scent", { tags: ["sporty"] }),
    item("inactive-scent", { tags: ["polished", "calm"], active: false }),
  ];

  it("filters by gender (unisex always) and active", () => {
    const ids = shortlistProducts(catalog, digest({ gender: "man" })).map((p) => p.id);
    expect(ids).toEqual(["men-scent", "unisex-scent"]);
    const her = shortlistProducts(catalog, digest({ gender: "woman" })).map((p) => p.id);
    expect(her).toEqual(["women-scent", "unisex-scent"]);
  });

  it("keeps a minimum per category even when another category scores higher", () => {
    const many: StyleCatalogItem[] = [];
    for (let i = 0; i < 20; i++) many.push(item(`scent-${String(i).padStart(2, "0")}`, { tags: ["polished", "calm", "evening"] }));
    for (let i = 0; i < 5; i++) many.push(item(`acc-${i}`, { category: "accents", tags: ["fresh"] }));
    for (let i = 0; i < 5; i++) many.push(item(`groom-${i}`, { category: "grooming", tags: ["fresh"] }));
    const shortlist = shortlistProducts(many, digest());
    expect(shortlist).toHaveLength(STYLE_SHORTLIST_SIZE);
    expect(shortlist.filter((p) => p.category === "accents")).toHaveLength(4);
    expect(shortlist.filter((p) => p.category === "grooming")).toHaveLength(4);
  });

  it("ranks by weighted overlap — the archetype counts double", () => {
    const weights = profileStyleTags(digest({ archetype: "sporty", tempo: "calm", places: [{ category: "lounge", count: 2 }] }));
    expect(weights.get("sporty")).toBe(2);
    expect(weights.get("calm")).toBe(1);
    expect(weights.get("evening")).toBe(1);
    const ranked = shortlistProducts(
      [item("a", { tags: ["calm"] }), item("b", { tags: ["sporty"] }), item("c", { tags: ["creative"] })],
      digest({ archetype: "sporty", tempo: "calm" }),
    ).map((p) => p.id);
    expect(ranked).toEqual(["b", "a", "c"]);
  });
});
