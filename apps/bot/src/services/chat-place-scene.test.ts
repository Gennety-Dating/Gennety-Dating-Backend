import { describe, expect, it, vi } from "vitest";

/**
 * Place scenes (decision 2026-11-26): every kind built from catalog facts,
 * counts and refusals, clamped text, delivery links and grounded dishes, the
 * versus rows, reading back, the view and the turn gating.
 */

const env = { AGENT_PLACE_SCENES_ENABLED: true, PUBLIC_BASE_URL: "https://api.gennety.test/", BOT_TOKEN: "t" };
vi.mock("../config.js", () => ({ env }));
vi.mock("@gennety/db", () => ({ prisma: {} }));

const {
  assemblePlaceScene,
  groundDishes,
  placeSceneNote,
  placeSceneView,
  placeScenesThisTurn,
  readPlaceScene,
  SHOW_PLACE_SCENE_TOOL,
  SEARCH_VENUES_TOOL,
  GET_MY_PLACES_TOOL,
} = await import("./chat-place-scene.js");
const { indexPlaces, toPlaceFacts } = await import("./place-catalog.js");
const { PLACE_SCENE_KINDS } = await import("@gennety/shared");
type Row = Parameters<typeof toPlaceFacts>[0][number];

const THU_10 = new Date("2026-11-26T08:00:00Z");
const hours = { periods: [{ open: { day: 4, hour: 9, minute: 0 }, close: { day: 4, hour: 22, minute: 0 } }] };

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    placeId: `pl-${id}`,
    name: `Place ${id}`,
    address: "вул. Хрещатик, 1",
    category: "restaurant",
    priority: 1,
    lat: 50.45,
    lng: 30.52,
    utcOffsetMinutes: 120,
    openingHours: hours,
    photoRefs: ["places/x/photos/y"],
    rating: 4.6,
    userRatingCount: 320,
    priceLevel: "PRICE_LEVEL_MODERATE",
    vibeTags: ["cozy"],
    facetTags: [],
    editorialSummary: null,
    primaryType: null,
    googleMapsUri: "https://maps.google.com/?cid=1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as Row;
}

const catalog = indexPlaces(
  "ua:kyiv",
  toPlaceFacts([
    row("a", { name: "Win Bar" }),
    row("b", { name: "Mlyn", lat: 50.454, rating: 4.8, priceLevel: "PRICE_LEVEL_INEXPENSIVE" }),
    row("c", { name: "Third", lat: 50.46, photoRefs: [] }),
    row("d", { name: "Fourth", lat: 50.47 }),
  ]),
);
const regulars = [{ anchorId: "pl-gym", name: "Gym Café", category: "cafe", lat: 50.452, lng: 30.52, visits: 6 }];
const ctx: Parameters<typeof assemblePlaceScene>[1] = { catalog, regulars, language: "ru", now: THU_10 };
const ok = (args: unknown, c = ctx) => {
  const out = assemblePlaceScene(args, c);
  if (!out.ok) throw new Error(out.result);
  return out;
};
const refusal = (args: unknown, c = ctx) => {
  const out = assemblePlaceScene(args, c);
  expect(out.ok).toBe(false);
  return JSON.parse(out.result) as { error: string };
};

describe("assemblePlaceScene — facts come from the catalog", () => {
  it("venue: every fact filled server-side, labels in their language", () => {
    const { scene, result } = ok({ kind: "venue", title: "Вот он", venues: [{ id: "a", reason: "тихо и вкусно", rating: 1 }] });
    expect(scene.venues[0]).toMatchObject({
      id: "a",
      name: "Win Bar",
      categoryLabel: "Ресторан",
      address: "вул. Хрещатик, 1",
      lat: 50.45,
      rating: 4.6,
      ratingCount: 320,
      priceLevel: 2,
      openNow: true,
      hoursLabel: "до 22:00",
      today: [{ open: "09:00", close: "22:00" }],
      nowLocal: "10:00",
      reason: "тихо и вкусно",
      walkMinutes: null,
    });
    expect(scene.links).toEqual([{ provider: "maps", label: "Карты", url: "https://maps.google.com/?cid=1" }]);
    expect(scene.versus).toBeNull();
    expect(JSON.parse(result)).toMatchObject({ success: true, shown: { kind: "venue" } });
  });

  it("unknown ids drop out; a scene with no valid venue is refused", () => {
    expect(ok({ kind: "venue", title: "x", venues: [{ id: "nope" }, { id: "b" }] }).scene.venues.map((v) => v.id)).toEqual(["b"]);
    expect(refusal({ kind: "venue", title: "x", venues: [{ id: "nope" }] }).error).toBe("no_valid_venue");
    expect(refusal({ kind: "nope", title: "x", venues: [{ id: "a" }] }).error).toBe("bad_kind");
  });

  it("any copy's id or the place id resolves to the naming copy", () => {
    expect(ok({ kind: "venue", title: "x", venues: [{ id: "pl-b" }] }).scene.venues[0]!.id).toBe("b");
  });

  it("picks: 2–3, cut at three, one place twice counts once", () => {
    expect(refusal({ kind: "picks", title: "x", venues: [{ id: "a" }, { id: "pl-a" }] }).error).toBe("too_few_venues");
    const picks = ok({ kind: "picks", title: "x", venues: ["a", "b", "c", "d"].map((id) => ({ id })) }).scene;
    expect(picks.venues.map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(picks.venues[2]!.photoVenueId).toBeNull();
    expect(picks.links).toEqual([]);
  });

  it("clamps the words", () => {
    const scene = ok({
      kind: "venue",
      title: "Очень длинный заголовок, который никак не помещается в одну строку",
      subtitle: "x".repeat(200),
      footnote: "y ".repeat(100),
      venues: [{ id: "a", reason: "причина ".repeat(30), tags: ["уютно", "z".repeat(60), "три", "четыре"] }],
    }).scene;
    expect([...scene.title].length).toBeLessThanOrEqual(40);
    expect([...scene.subtitle!].length).toBeLessThanOrEqual(80);
    expect([...scene.footnote!].length).toBeLessThanOrEqual(90);
    expect([...scene.venues[0]!.reason!].length).toBeLessThanOrEqual(70);
    expect(scene.venues[0]!.tags).toHaveLength(3);
  });
});

describe("kinds with a start point", () => {
  it("regulars: their places as anchors, minutes from the nearest written by the server", () => {
    const scene = ok({ kind: "regulars", title: "Новое рядом", subtitle: "мимо", venues: [{ id: "b" }] }).scene;
    expect(scene.anchors).toEqual([{ label: "Gym Café", lat: 50.452, lng: 30.52, visits: 6 }]);
    expect(scene.venues[0]!.walkMinutes).toBeGreaterThan(0);
    expect(scene.subtitle).toBe(`${scene.venues[0]!.walkMinutes} мин от Gym Café`);
  });

  it("regulars without the opt-in, or without places, is refused", () => {
    expect(refusal({ kind: "regulars", title: "x", venues: [{ id: "b" }] }, { ...ctx, regulars: null }).error).toBe("no_regulars");
    expect(refusal({ kind: "regulars", title: "x", venues: [{ id: "b" }] }, { ...ctx, regulars: [] }).error).toBe("no_regulars");
  });

  it("route: one start, from their place or a catalog place; none is refused", () => {
    const fromRegular = ok({ kind: "route", title: "x", venues: [{ id: "a" }], anchor_ids: ["pl-gym"] }).scene;
    expect(fromRegular.anchors).toHaveLength(1);
    expect(fromRegular.venues[0]!.distanceM).toBeGreaterThan(200);
    const fromVenue = ok({ kind: "route", title: "x", venues: [{ id: "b" }], anchor_ids: ["a"] }).scene;
    expect(fromVenue.anchors[0]!.label).toBe("Win Bar");
    expect(fromVenue.subtitle).toMatch(/мин от Win Bar$/);
    expect(refusal({ kind: "route", title: "x", venues: [{ id: "a" }] }).error).toBe("no_start");
  });
});

describe("delivery", () => {
  it("search links on Glovo and Bolt Food for the venue in their city, no dish without reviews", () => {
    const { scene, result } = ok({ kind: "delivery", title: "Заказать", venues: [{ id: "a" }], dishes: [{ name: "Борщ" }] });
    expect(scene.links).toEqual([
      { provider: "glovo", label: "Glovo", url: "https://glovoapp.com/ru/ua/kyiv/search?q=Win%20Bar" },
      { provider: "bolt", label: "Bolt Food", url: "https://food.bolt.eu/ru-ru/325-kyiv/search/?q=Win%20Bar" },
    ]);
    expect(scene.dishes).toEqual([]);
    expect(JSON.parse(result).instruction).toContain("No grounded dishes");
  });

  it("a city no service covers: refused", () => {
    const other = indexPlaces("pl:warsaw", catalog.places);
    expect(refusal({ kind: "delivery", title: "x", venues: [{ id: "a" }] }, { ...ctx, catalog: other }).error).toBe("no_delivery_here");
  });

  it("dishes only when a review names them", () => {
    expect(groundDishes([{ name: "Борщ" }, { name: "Тирамису" }, { name: "борщ" }], ["Брали борщ с пампушками — топ"])).toEqual([
      { name: "Борщ", note: null, price: null },
    ]);
    expect(groundDishes([{ name: "Борщ" }], [])).toEqual([]);
  });
});

describe("versus", () => {
  it("exactly two; the server's rows first, the model's qualities after, numbers in them dropped", () => {
    expect(refusal({ kind: "versus", title: "x", venues: [{ id: "a" }] }).error).toBe("too_few_venues");
    const { scene } = ok({
      kind: "versus",
      title: "Win Bar или Mlyn",
      venues: [{ id: "a" }, { id: "b" }, { id: "c" }],
      anchor_ids: ["pl-gym"],
      versus: {
        winner: "b",
        verdict: "Mlyn для первого свидания",
        rows: [
          { label: "Шум", a: "громко", b: "тихо", better: "b" },
          { label: "Рейтинг", a: "5", b: "1", better: "a" },
          { label: "Вид", a: "4 этаж", b: "двор", better: "a" },
        ],
      },
    });
    expect(scene.venues.map((v) => v.id)).toEqual(["a", "b"]);
    expect(scene.versus).toEqual({
      winner: "b",
      verdict: "Mlyn для первого свидания",
      rows: [
        { label: "Рейтинг", a: "4.6", b: "4.8", better: "b" },
        { label: "Чек", a: "₴₴", b: "₴", better: "b" },
        { label: "Пешком", a: expect.stringMatching(/′$/), b: expect.stringMatching(/′$/), better: expect.any(String) },
        { label: "Шум", a: "громко", b: "тихо", better: "b" },
      ],
    });
  });

  it("no winner given: the rows decide", () => {
    const { scene } = ok({ kind: "versus", title: "x", venues: [{ id: "a" }, { id: "b" }] });
    expect(scene.versus?.winner).toBe("b");
  });
});

describe("reading back and the view", () => {
  it("stored → read → view: as shown, the photo signed by the caller, the internal id gone", () => {
    const { scene } = ok({ kind: "picks", title: "Куда сходить", venues: [{ id: "a" }, { id: "c" }] });
    const stored = JSON.parse(JSON.stringify(scene));
    const back = readPlaceScene(stored)!;
    expect(back).toEqual(scene);
    const view = placeSceneView(back, (id) => `https://img.test/${id}`);
    expect(view.kind).toBe("picks");
    expect(view).not.toHaveProperty("versus");
    expect(view.venues[0]!.photoUrl).toBe("https://img.test/a");
    expect(view.venues[1]!.photoUrl).toBeNull();
    expect(view.venues[0]).not.toHaveProperty("photoVenueId");
    expect(placeSceneNote(back)).toContain("«Win Bar» (id a)");
  });

  it("anything else is not a scene", () => {
    expect(readPlaceScene(null)).toBeNull();
    expect(readPlaceScene({ kind: "vibe_card" })).toBeNull();
    expect(readPlaceScene({ kind: "place_scene", sceneKind: "venue", title: "x", venues: [] })).toBeNull();
    expect(readPlaceScene({ kind: "place_scene", sceneKind: "moon", title: "x", venues: [{ id: "a", name: "A", lat: 1, lng: 2 }] })).toBeNull();
  });
});

describe("turn gating and the tools", () => {
  it("only a build that sends `places`, only with the flag", () => {
    expect(placeScenesThisTurn(new Set(["places", "vibe"]))).toBe(true);
    expect(placeScenesThisTurn(new Set(["vibe"]))).toBe(false);
    expect(placeScenesThisTurn(undefined)).toBe(false);
    env.AGENT_PLACE_SCENES_ENABLED = false;
    expect(placeScenesThisTurn(new Set(["places"]))).toBe(false);
    env.AGENT_PLACE_SCENES_ENABLED = true;
  });

  it("the tool offers exactly the contract's kinds", () => {
    expect(SHOW_PLACE_SCENE_TOOL.function.parameters.properties.kind.enum).toEqual([...PLACE_SCENE_KINDS]);
    expect(new Set([SHOW_PLACE_SCENE_TOOL, SEARCH_VENUES_TOOL, GET_MY_PLACES_TOOL].map((tool) => tool.function.name)).size).toBe(3);
  });
});
