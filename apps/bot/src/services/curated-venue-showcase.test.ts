/**
 * The standby showcase — which curated places the iOS canvas shows, in which
 * order and in what shape. The selection is pure and tested directly; the DB
 * read goes through a mocked Prisma, the same seam the route tests use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  SHOWCASE_CACHE_TTL_MS,
  SHOWCASE_LIMIT,
} = await import("./curated-venue.js");
type Candidate = import("./curated-venue.js").ShowcaseCandidate;

let seq = 0;
function row(overrides: Partial<Candidate> = {}): Candidate {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    placeId: `place-${seq}`,
    name: `Place ${seq}`,
    address: `Street ${seq}`,
    category: "cafe",
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
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
  findMany.mockReset();
  findUnique.mockReset();
  resetShowcaseCache();
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

  it("keeps every tier — the brief asks for all active places", () => {
    // Tiers are not a column the showcase reads; this pins that no filter
    // sneaks in through the category or priority either.
    expect(selectShowcase([row({ priority: 3 }), row({ priority: 1 })])).toHaveLength(2);
  });

  it("ranks by the operator's priority, then a photo, then the rating", () => {
    const low = row({ priority: 2, rating: 4.9 });
    const noPhoto = row({ priority: 1, photoRefs: [], rating: 4.8 });
    const best = row({ priority: 1, rating: 4.1 });

    const picked = selectShowcase([low, noPhoto, best], 2);

    expect(picked.map((p) => p.id)).toEqual([best.id, noPhoto.id]);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ lat: 50.4 + i * 0.001 }));

    expect(selectShowcase(rows)).toHaveLength(SHOWCASE_LIMIT);
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

  it("answers the card's shape: a photo flag instead of refs, periods, a trimmed summary", async () => {
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
    expect(first.hasPhoto).toBe(true);
    expect(first.editorialSummary).toBe("Books and coffee.");
    expect(first.openingHours).toHaveLength(1);
    expect(second.hasPhoto).toBe(false);
    expect(second.editorialSummary).toBeNull();
  });

  it("serves one city's selection from memory for the cache window", async () => {
    findMany.mockResolvedValue([row()]);

    await getShowcaseVenues("ua:kyiv", 1_000);
    await getShowcaseVenues("ua:kyiv", 1_000 + SHOWCASE_CACHE_TTL_MS - 1);
    expect(findMany).toHaveBeenCalledOnce();

    await getShowcaseVenues("ua:kyiv", 1_000 + SHOWCASE_CACHE_TTL_MS + 1);
    expect(findMany).toHaveBeenCalledTimes(2);
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
});
