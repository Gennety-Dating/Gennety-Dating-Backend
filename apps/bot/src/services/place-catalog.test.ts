import { describe, expect, it, vi } from "vitest";

/**
 * The city's places for the chat agent (decision 2026-11-26): folding catalog
 * copies, the clock (past midnight, closed, unknown), the walk, the person's
 * regular places and the search.
 */

vi.mock("@gennety/db", () => ({ prisma: {} }));

const { indexPlaces, placeClock, placeWalk, rankRegulars, searchPlaces, toPlaceFacts } = await import("./place-catalog.js");
type Row = Parameters<typeof toPlaceFacts>[0][number];

const KYIV = 120;
/** Thursday 2026-11-26, 10:00 in Kyiv (UTC+2). */
const THU_10 = new Date("2026-11-26T08:00:00Z");
const p = (oD: number, oH: number, cD: number, cH: number, oM = 0, cM = 0) => ({
  open: { day: oD, hour: oH, minute: oM },
  close: { day: cD, hour: cH, minute: cM },
});

function row(over: Partial<Row> & { id: string }): Row {
  return {
    placeId: `pl-${over.id}`,
    name: `Place ${over.id}`,
    address: "вул. Хрещатик, 1",
    category: "cafe",
    priority: 2,
    lat: 50.45,
    lng: 30.52,
    utcOffsetMinutes: KYIV,
    openingHours: null,
    photoRefs: ["places/x/photos/y"],
    rating: 4.5,
    userRatingCount: 200,
    priceLevel: "PRICE_LEVEL_MODERATE",
    vibeTags: [],
    facetTags: [],
    editorialSummary: null,
    primaryType: null,
    googleMapsUri: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as Row;
}

describe("toPlaceFacts", () => {
  it("folds a place's copies: the best copy names it, a copy with a photo lends it", () => {
    const places = toPlaceFacts([
      row({ id: "b", placeId: "same", name: "Second copy", priority: 2, photoRefs: ["places/a/photos/1"] }),
      row({ id: "a", placeId: "same", name: "Win Bar", priority: 1, photoRefs: [] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ id: "a", name: "Win Bar", photoVenueId: "b", ids: ["a", "b"], priceLevel: 2 });
    const catalog = indexPlaces("ua:kyiv", places);
    expect(catalog.byId.get("b")?.id).toBe("a");
    expect(catalog.byId.get("same")?.id).toBe("a");
  });

  it("drops a row without a point and keeps an out-of-range rating out", () => {
    const places = toPlaceFacts([row({ id: "z", lat: 0, lng: 0 }), row({ id: "r", rating: 7 })]);
    expect(places.map((x) => x.id)).toEqual(["r"]);
    expect(places[0]!.rating).toBeNull();
  });
});

describe("placeClock", () => {
  it("open now: until the close, today's interval, the local time", () => {
    const clock = placeClock([p(4, 9, 4, 22)], KYIV, THU_10, "ru");
    expect(clock).toEqual({ nowLocal: "10:00", openNow: true, today: [{ open: "09:00", close: "22:00" }], hoursLabel: "до 22:00", minutesToChange: 720 });
  });

  it("past midnight: yesterday's evening still runs, today's runs into tomorrow", () => {
    const thu0130 = new Date("2026-11-25T23:30:00Z");
    const clock = placeClock([p(3, 18, 4, 2), p(4, 18, 5, 2)], KYIV, thu0130, "ru");
    expect(clock.openNow).toBe(true);
    expect(clock.hoursLabel).toBe("до 2:00");
    expect(clock.nowLocal).toBe("01:30");
    expect(clock.today).toEqual([
      { open: "00:00", close: "02:00" },
      { open: "18:00", close: "02:00" },
    ]);
  });

  it("an evening that crosses the week boundary (Saturday into Sunday)", () => {
    const sun0100 = new Date("2026-11-28T23:00:00Z");
    expect(placeClock([p(6, 20, 0, 3)], KYIV, sun0100, "en")).toMatchObject({ openNow: true, hoursLabel: "until 3:00" });
  });

  it("closed, opens later today / tomorrow / not soon", () => {
    expect(placeClock([p(4, 18, 5, 2)], KYIV, THU_10, "ru")).toMatchObject({ openNow: false, hoursLabel: "откроется в 18:00", minutesToChange: 480 });
    const thu20 = new Date("2026-11-26T18:00:00Z");
    expect(placeClock([p(5, 9, 5, 18)], KYIV, thu20, "ru")).toMatchObject({ openNow: false, hoursLabel: "откроется завтра в 9:00", today: [] });
    expect(placeClock([p(1, 9, 1, 18)], KYIV, THU_10, "uk")).toMatchObject({ openNow: false, hoursLabel: "зараз зачинено" });
  });

  it("a close at midnight reads 00:00; a whole day reads 00:00–24:00", () => {
    expect(placeClock([p(4, 10, 5, 0)], KYIV, THU_10, "en").today).toEqual([{ open: "10:00", close: "00:00" }]);
    expect(placeClock([{ open: { day: 0, hour: 0, minute: 0 } }], KYIV, THU_10, "en")).toMatchObject({
      openNow: true,
      today: [{ open: "00:00", close: "24:00" }],
      hoursLabel: "open 24 hours",
    });
  });

  it("unknown hours or an unknown offset: never a guess", () => {
    expect(placeClock([], KYIV, THU_10, "ru")).toEqual({ nowLocal: "10:00", openNow: null, today: [], hoursLabel: null, minutesToChange: null });
    expect(placeClock([p(4, 9, 4, 22)], null, THU_10, "ru")).toEqual({ nowLocal: null, openNow: null, today: [], hoursLabel: null, minutesToChange: null });
  });
});

describe("placeWalk", () => {
  it("minutes over a street path, none beyond a walk", () => {
    const near = placeWalk({ lat: 50.45, lng: 30.52 }, { lat: 50.454, lng: 30.52 });
    expect(near.distanceM).toBeGreaterThan(430);
    expect(near.distanceM).toBeLessThan(460);
    expect(near.walkMinutes).toBe(7);
    expect(placeWalk({ lat: 50.45, lng: 30.52 }, { lat: 50.52, lng: 30.52 }).walkMinutes).toBeNull();
  });
});

describe("rankRegulars", () => {
  const catalog = indexPlaces("ua:kyiv", toPlaceFacts([row({ id: "1" }), row({ id: "2" }), row({ id: "3" })]));
  it("two days at least, hidden places out, most days first", () => {
    const regulars = rankRegulars({
      catalog,
      hidden: new Set(["pl-3"]),
      firstDay: "2026-10-01",
      visits: [
        { placeId: "pl-1", day: "2026-11-01" },
        { placeId: "pl-1", day: "2026-11-02" },
        { placeId: "pl-2", day: "2026-11-01" },
        { placeId: "pl-2", day: "2026-11-02" },
        { placeId: "pl-2", day: "2026-11-03" },
        { placeId: "pl-3", day: "2026-11-01" },
        { placeId: "pl-3", day: "2026-11-02" },
        { placeId: "pl-1", day: "2026-09-01" },
        { placeId: "pl-unknown", day: "2026-11-01" },
        { placeId: "pl-unknown", day: "2026-11-02" },
      ],
    });
    expect(regulars.map((r) => [r.anchorId, r.visits])).toEqual([["pl-2", 3], ["pl-1", 2]]);
  });
});

describe("searchPlaces", () => {
  const catalog = indexPlaces(
    "ua:kyiv",
    toPlaceFacts([
      row({ id: "coffee", name: "Mlyn Coffee", category: "coffee_shop", lat: 50.46, lng: 30.52, rating: 4.9, openingHours: { periods: [p(4, 8, 4, 20)] } }),
      row({ id: "bar", name: "Win Bar", category: "lounge", lat: 50.45, lng: 30.52, rating: 4.4, openingHours: { periods: [p(4, 18, 5, 2)] } }),
      row({ id: "far", name: "Far Cafe", category: "cafe", lat: 50.40, lng: 30.60, rating: 4.8 }),
    ]),
  );
  const ctx = { now: THU_10, language: "en" as const, regulars: [] };

  it("a query must hit a word; a category filters", () => {
    expect(searchPlaces(catalog, { query: "win bar" }, ctx).map((h) => h.place.id)).toEqual(["bar"]);
    expect(searchPlaces(catalog, { query: "кофе" }, ctx).map((h) => h.place.id)).toEqual(["coffee"]);
    expect(searchPlaces(catalog, { query: "sushi" }, ctx)).toEqual([]);
    expect(searchPlaces(catalog, { category: "lounge" }, ctx).map((h) => h.place.id)).toEqual(["bar"]);
  });

  it("open now drops what is known to be closed, keeps what is unknown", () => {
    expect(searchPlaces(catalog, { openNow: true }, ctx).map((h) => h.place.id).sort()).toEqual(["coffee", "far"]);
  });

  it("near ranks by distance; without it, places near their regulars come first", () => {
    const fromBar = searchPlaces(catalog, { near: { lat: 50.45, lng: 30.52 } }, ctx);
    expect(fromBar.map((h) => h.place.id)).toEqual(["bar", "coffee", "far"]);
    expect(fromBar[1]!.walk?.walkMinutes).toBeGreaterThan(0);
    const regular = { anchorId: "pl-x", name: "Gym café", category: "cafe", lat: 50.401, lng: 30.6, visits: 4 };
    const ranked = searchPlaces(catalog, { limit: 2 }, { ...ctx, regulars: [regular] });
    expect(ranked[0]!.place.id).toBe("far");
    expect(ranked[0]!.nearestRegular?.regular.name).toBe("Gym café");
    expect(ranked).toHaveLength(2);
  });
});
