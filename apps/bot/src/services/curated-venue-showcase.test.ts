/**
 * The standby showcase — which curated places the iOS canvas shows, in which
 * order and in what shape. The selection is pure and tested directly; the DB
 * read goes through a mocked Prisma, the same seam the route tests use.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    curatedVenue: {
      findMany: (...a: unknown[]) => findMany(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
  },
}));

const {
  getShowcaseVenues,
  normalizeOpeningPeriods,
  orderAsWalk,
  resetShowcaseCache,
  selectShowcase,
  showcasePhotoRef,
  showcasePriceLevel,
  SHOWCASE_CACHE_TTL_MS,
  SHOWCASE_GALLERY_MAX,
  SHOWCASE_LIMIT,
} = await import("./curated-venue.js");
type Candidate = import("./curated-venue.js").ShowcaseCandidate;
const { SHOWCASE_PICKS, isShowcaseExcludedKitchen } = await import("./showcase-curation.js");

let seq = 0;
function row(overrides: Partial<Candidate> = {}): Candidate {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    placeId: `place-${seq}`,
    // One word: the rule keeps one card per brand, and "Place 1"/"Place 2"
    // would read as two branches of a chain called "Place".
    name: `Place${seq}`,
    address: `Street ${seq}`,
    category: "cafe",
    tier: "base",
    primaryType: null,
    priority: 2,
    lat: 50.45,
    lng: 30.52,
    editorialSummary: null,
    vibeTags: [],
    facetTags: [],
    utcOffsetMinutes: 180,
    openingHours: null,
    photoRefs: ["places/x/photos/y"],
    rating: 4.5,
    userRatingCount: 100,
    priceLevel: null,
    googleMapsUri: null,
    ...overrides,
  };
}

// Every Kyiv read below misses the hand-picked ids and says so; keep it quiet.
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  seq = 0;
  findMany.mockReset();
  findUnique.mockReset();
  resetShowcaseCache();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("selectShowcase", () => {
  it("keeps one entry per real place — the catalog holds a copy per university domain", () => {
    const worse = row({ placeId: "same", priority: 2, photoRefs: [] });
    const better = row({ placeId: "same", priority: 1 });
    const other = row({ placeId: "other" });

    const picked = selectShowcase([worse, better, other]);

    expect(picked.map((p) => p.placeId).sort()).toEqual(["other", "same"]);
    expect(picked.find((p) => p.placeId === "same")?.id).toBe(better.id);
  });

  it("dedupes rows without a place id by name and position", () => {
    const a = row({ placeId: null, name: "Двір", lat: 50.45341, lng: 30.51211 });
    const b = row({ placeId: null, name: " двір ", lat: 50.45339, lng: 30.51209 });

    expect(selectShowcase([a, b])).toHaveLength(1);
  });

  it("leaves out what the product never offers: museums and blocked names", () => {
    const picked = selectShowcase([
      row({ category: "museum" }),
      row({ name: "Beatnik Bar" }),
      row({ name: "Sens" }),
    ]);

    expect(picked.map((p) => p.name)).toEqual(["Sens"]);
  });

  it("ranks premium first, then the operator's priority, then a photo, then the rating", () => {
    const low = row({ priority: 2, rating: 4.9 });
    const noPhoto = row({ priority: 1, photoRefs: [], rating: 4.8 });
    const best = row({ priority: 1, rating: 4.1 });
    const premium = row({ tier: "premium", priority: 3, rating: 4.0 });

    expect(selectShowcase([low, noPhoto, best], { limit: 2 }).map((p) => p.id)).toEqual([best.id, noPhoto.id]);
    expect(selectShowcase([low, noPhoto, best, premium], { limit: 1 }).map((p) => p.id)).toEqual([premium.id]);
  });

  it("never shows the board-only tier or a kitchen the founder struck", () => {
    const picked = selectShowcase([
      row({ name: "Mama Gochi", tier: "alternative" }),
      row({ name: "Чічіко", tier: "premium", primaryType: "eastern_european_restaurant" }),
      row({ name: "Шоті", primaryType: "restaurant" }),
      row({ name: "Софра • Смак Криму" }),
      row({ name: "Даш кафе", primaryType: "halal_restaurant" }),
      row({ name: "Шаурма на районі" }),
      row({ name: "Biggoli", tier: "premium", primaryType: "italian_restaurant" }),
      row({ name: "Coffee Records" }),
    ]);

    expect(picked.map((p) => p.name).sort()).toEqual(["Biggoli", "Coffee Records"]);
  });

  it("keeps one card per brand, the best branch", () => {
    const picked = selectShowcase([
      row({ name: "Пиріжкова Тітка Клара", rating: 4.5 }),
      row({ name: "Пиріжкова тітка Клара", rating: 4.7 }),
      row({ name: "Idealist Coffee IQ", rating: 4.6 }),
      row({ name: "Idealist Coffee на Коновальця", rating: 4.3 }),
      row({ name: "ONE LOVE coffee" }),
      row({ name: "One Tea Tree" }),
    ]);

    expect(picked).toHaveLength(4);
    expect(picked.find((p) => p.name.startsWith("Пиріжкова"))?.rating).toBe(4.7);
    expect(picked.find((p) => p.name.startsWith("Idealist"))?.name).toBe("Idealist Coffee IQ");
  });

  it("leaves out a row outside the city — the catalog's Paris La Coupole", () => {
    const kyiv = { latitude: 50.4501, longitude: 30.5234, radiusKm: 21 };
    const paris = row({ name: "La Coupole", tier: "premium", lat: 48.8422546, lng: 2.3279506 });
    const podil = row({ name: "Win Bar", lat: 50.4664, lng: 30.5159 });

    expect(selectShowcase([paris, podil], { city: kyiv }).map((p) => p.name)).toEqual(["Win Bar"]);
    expect(selectShowcase([paris, podil], { city: kyiv, picks: [paris.placeId!, podil.placeId!] }).map((p) => p.name)).toEqual(["Win Bar"]);
  });

  it("shows exactly the hand-picked list when the city has one, the rule's exclusions notwithstanding", () => {
    const first = row({ name: "Кафе Fandom", tier: "premium", lat: 50.44 });
    const struck = row({ name: "Georgia", tier: "alternative", lat: 50.45 });
    const unpicked = row({ name: "Very Well Cafe", tier: "premium", rating: 5, lat: 50.46 });

    const picked = selectShowcase([unpicked, struck, first], { picks: [first.placeId!, struck.placeId!, "gone"] });

    expect(picked.map((p) => p.name)).toEqual(["Кафе Fandom", "Georgia"]);
  });

  it("falls back to the rule when none of the picks is in the catalog any more", () => {
    const place = row({ name: "Coffee Records" });

    expect(selectShowcase([place], { picks: ["gone", "also-gone"] }).map((p) => p.name)).toEqual(["Coffee Records"]);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: SHOWCASE_LIMIT + 16 }, (_, i) => row({ lat: 50.4 + i * 0.001 }));

    expect(selectShowcase(rows)).toHaveLength(SHOWCASE_LIMIT);
    expect(selectShowcase(rows, { picks: rows.map((r) => r.placeId!) })).toHaveLength(SHOWCASE_LIMIT);
  });
});

describe("orderAsWalk", () => {
  it("starts at the first place and always steps to the nearest one not yet shown", () => {
    const start = { id: "start", lat: 50.4, lng: 30.5 };
    const far = { id: "far", lat: 50.43, lng: 30.5 };
    const near = { id: "near", lat: 50.41, lng: 30.5 };
    const mid = { id: "mid", lat: 50.42, lng: 30.5 };

    expect(orderAsWalk([start, far, near, mid]).map((p) => p.id)).toEqual([
      "start",
      "near",
      "mid",
      "far",
    ]);
  });

  it("does not mutate its input", () => {
    const places = [
      { lat: 50.4, lng: 30.5 },
      { lat: 50.43, lng: 30.5 },
      { lat: 50.41, lng: 30.5 },
    ];
    const copy = [...places];
    orderAsWalk(places);
    expect(places).toEqual(copy);
  });
});

describe("normalizeOpeningPeriods", () => {
  it("keeps Google's periods as integers in local time", () => {
    expect(
      normalizeOpeningPeriods({
        periods: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 30 } }],
      }),
    ).toEqual([{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 30 } }]);
  });

  it("reads a missing field as zero, the same reading isVenueOpenAt uses", () => {
    expect(
      normalizeOpeningPeriods({
        periods: [{ open: { day: 5, hour: 18 }, close: { day: 6, hour: 2 } }],
      } as never),
    ).toEqual([{ open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }]);
  });

  it("keeps an open-with-no-close period — Google's 'around the clock'", () => {
    expect(normalizeOpeningPeriods({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] } as never)).toEqual([
      { open: { day: 0, hour: 0, minute: 0 } },
    ]);
  });

  it("answers an empty list for unknown hours — never a closed week", () => {
    expect(normalizeOpeningPeriods(null)).toEqual([]);
    expect(normalizeOpeningPeriods({})).toEqual([]);
  });

  it("drops a period it cannot read rather than guessing", () => {
    expect(
      normalizeOpeningPeriods({
        periods: [{ open: { day: 9, hour: 8, minute: 0 } }, {}, { open: { day: 1, hour: 8.5 } }],
      } as never),
    ).toEqual([]);
  });
});

describe("getShowcaseVenues", () => {
  it("reads active rows of the city and never the excluded categories", async () => {
    findMany.mockResolvedValue([row()]);

    await getShowcaseVenues("ua:kyiv");

    expect(findMany.mock.calls[0][0].where).toEqual({
      cityKey: "ua:kyiv",
      active: true,
      category: { notIn: ["museum"] },
    });
  });

  it("answers the card's shape: a photo count instead of refs, periods, a trimmed summary", async () => {
    findMany.mockResolvedValue([
      row({
        editorialSummary: "  Books and coffee.  ",
        openingHours: { periods: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }] },
      }),
      row({ editorialSummary: "   ", photoRefs: [] }),
    ]);

    const [first, second] = await getShowcaseVenues("ua:kyiv");

    expect(first).not.toHaveProperty("photoRefs");
    expect(first).not.toHaveProperty("priority");
    expect(first.photoCount).toBe(1);
    expect(first.editorialSummary).toBe("Books and coffee.");
    expect(first.openingHours).toHaveLength(1);
    expect(second.photoCount).toBe(0);
    expect(second.editorialSummary).toBeNull();
  });

  it("caps the gallery at the founder's five, however many photos the catalog holds", async () => {
    const refs = Array.from({ length: 10 }, (_, i) => `places/x/photos/${i}`);
    findMany.mockResolvedValue([row({ photoRefs: refs })]);

    const [place] = await getShowcaseVenues("ua:kyiv");

    expect(SHOWCASE_GALLERY_MAX).toBe(5);
    expect(place.photoCount).toBe(5);
  });

  it("carries the profile's facts — price, rating, the Maps page — and reads them from the catalog", async () => {
    findMany.mockResolvedValue([
      row({
        priceLevel: "PRICE_LEVEL_MODERATE",
        rating: 4.6,
        userRatingCount: 1204,
        googleMapsUri: "https://maps.google.com/?cid=123",
      }),
    ]);

    const [place] = await getShowcaseVenues("ua:kyiv");

    expect(findMany.mock.calls[0][0].select).toMatchObject({ priceLevel: true, googleMapsUri: true });
    expect(place).toMatchObject({
      priceLevel: "moderate",
      rating: 4.6,
      userRatingCount: 1204,
      mapsUri: "https://maps.google.com/?cid=123",
    });
    expect(place).not.toHaveProperty("googleMapsUri");
  });

  it("drops facts a client could not use as is rather than passing junk through", async () => {
    findMany.mockResolvedValue([
      row({ priceLevel: "PRICE_LEVEL_UNSPECIFIED", rating: 0, userRatingCount: -3, googleMapsUri: "javascript:alert(1)" }),
      row({ priceLevel: null, rating: Number.NaN, userRatingCount: 2.5, googleMapsUri: "http://maps.google.com/?cid=1" }),
      row({ rating: null, userRatingCount: null, googleMapsUri: "not a url" }),
    ]);

    const places = await getShowcaseVenues("ua:kyiv");

    for (const place of places) {
      expect(place.priceLevel).toBeNull();
      expect(place.rating).toBeNull();
      expect(place.userRatingCount).toBeNull();
      expect(place.mapsUri).toBeNull();
    }
  });

  it("serves one city's selection from memory for the cache window", async () => {
    findMany.mockResolvedValue([row()]);

    await getShowcaseVenues("ua:kyiv", 1_000);
    await getShowcaseVenues("ua:kyiv", 1_000 + SHOWCASE_CACHE_TTL_MS - 1);
    expect(findMany).toHaveBeenCalledOnce();

    await getShowcaseVenues("ua:kyiv", 1_000 + SHOWCASE_CACHE_TTL_MS + 1);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("serves Kyiv's hand-picked list and names the picks it could not show", async () => {
    const fandom = row({ placeId: SHOWCASE_PICKS["ua:kyiv"]![0]!.placeId, name: "Кафе Fandom", tier: "premium" });
    findMany.mockResolvedValue([fandom, row({ name: "Not picked", tier: "premium", rating: 5 })]);

    const places = await getShowcaseVenues("ua:kyiv");

    expect(places.map((p) => p.name)).toEqual(["Кафе Fandom"]);
    expect(findMany.mock.calls[0][0].select).toMatchObject({ tier: true, primaryType: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("Win Bar");
  });

  it("keeps the Kyiv list inside the limit, unique, and free of the struck kitchens", () => {
    const kyiv = SHOWCASE_PICKS["ua:kyiv"]!;
    expect(kyiv.length).toBeGreaterThanOrEqual(55);
    expect(kyiv.length).toBeLessThanOrEqual(SHOWCASE_LIMIT);
    expect(new Set(kyiv.map((pick) => pick.placeId)).size).toBe(kyiv.length);
    for (const pick of kyiv) expect(isShowcaseExcludedKitchen({ name: pick.name, primaryType: null })).toBe(false);
  });

  it("keeps cities apart", async () => {
    findMany.mockResolvedValueOnce([row({ name: "Kyiv place" })]).mockResolvedValueOnce([]);

    expect(await getShowcaseVenues("ua:kyiv")).toHaveLength(1);
    expect(await getShowcaseVenues("ua:odesa")).toEqual([]);
  });
});

describe("showcasePhotoRef", () => {
  it("answers the first photo of an active row", async () => {
    findUnique.mockResolvedValue({ active: true, photoRefs: ["places/a/photos/1", "places/a/photos/2"] });

    expect(await showcasePhotoRef("id")).toBe("places/a/photos/1");
  });

  it("answers nothing for a retired or missing row", async () => {
    findUnique.mockResolvedValueOnce({ active: false, photoRefs: ["places/a/photos/1"] });
    expect(await showcasePhotoRef("id")).toBeNull();

    findUnique.mockResolvedValueOnce(null);
    expect(await showcasePhotoRef("id")).toBeNull();
  });

  it("answers nothing for a row the nightly scan has not reached", async () => {
    findUnique.mockResolvedValue({ active: true, photoRefs: [] });

    expect(await showcasePhotoRef("id")).toBeNull();
  });

  it("answers a gallery slot, and nothing past the row's photos or the cap", async () => {
    const refs = Array.from({ length: 8 }, (_, i) => `places/a/photos/${i}`);
    findUnique.mockResolvedValue({ active: true, photoRefs: refs });

    expect(await showcasePhotoRef("id", 3)).toBe("places/a/photos/3");
    expect(await showcasePhotoRef("id", SHOWCASE_GALLERY_MAX - 1)).toBe("places/a/photos/4");
    // Held by the catalog, but past the cap — the cap is the bill.
    expect(await showcasePhotoRef("id", SHOWCASE_GALLERY_MAX)).toBeNull();
    expect(await showcasePhotoRef("id", -1)).toBeNull();

    findUnique.mockResolvedValue({ active: true, photoRefs: refs.slice(0, 2) });
    expect(await showcasePhotoRef("id", 2)).toBeNull();
  });

  it("never reads the catalog for a slot it would refuse anyway", async () => {
    expect(await showcasePhotoRef("id", SHOWCASE_GALLERY_MAX)).toBeNull();
    expect(await showcasePhotoRef("id", 1.5)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("showcasePriceLevel", () => {
  it("reads both spellings the catalog has held, and nothing else", () => {
    expect(showcasePriceLevel("PRICE_LEVEL_FREE")).toBe("free");
    expect(showcasePriceLevel("inexpensive")).toBe("inexpensive");
    expect(showcasePriceLevel("PRICE_LEVEL_EXPENSIVE")).toBe("expensive");
    // Not folded into "expensive" the way the venue policy folds it: the
    // profile shows the level, it does not decide on it.
    expect(showcasePriceLevel("PRICE_LEVEL_VERY_EXPENSIVE")).toBe("very_expensive");
    expect(showcasePriceLevel("PRICE_LEVEL_UNSPECIFIED")).toBeNull();
    expect(showcasePriceLevel(undefined)).toBeNull();
  });
});
