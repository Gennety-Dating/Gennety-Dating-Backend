import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proactive place tips (decision 2026-11-26): who may get one and when (the
 * cadence, daytime, quiet hours, two ignored in a row), which place, what is
 * stored and pushed — and that an empty preview list sends nothing.
 */

const env = { PUBLIC_BASE_URL: "https://api.gennety.test", BOT_TOKEN: "t", AGENT_PLACE_TIPS_ENABLED: false, AGENT_PLACE_TIPS_USER_IDS: [] as string[] };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";
const db = {
  userFindMany: vi.fn(),
  userFindUnique: vi.fn(async () => ({ frequentPlacesOptIn: true })),
  messageFindMany: vi.fn(async (): Promise<unknown[]> => []),
  messageFindFirst: vi.fn(async (): Promise<unknown> => null),
  messageCreate: vi.fn(async (a: { data: unknown }) => ({ id: "tip-1", createdAt: new Date("2026-11-26T10:00:00Z"), data: a.data })),
  visitFindMany: vi.fn(),
  curatedFindMany: vi.fn(),
  sessionFindFirst: vi.fn(async (): Promise<unknown> => null),
  sessionCreate: vi.fn(async () => ({ id: "s-new" })),
};
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findMany: (a: unknown) => db.userFindMany(a), findUnique: () => db.userFindUnique() },
    message: {
      findMany: () => db.messageFindMany(),
      findFirst: () => db.messageFindFirst(),
      create: (a: { data: unknown }) => db.messageCreate(a),
    },
    userPlaceVisit: { findMany: (a: unknown) => db.visitFindMany(a) },
    match: { findMany: async () => [] },
    userHiddenPlace: { findMany: async () => [] },
    curatedVenue: { findMany: () => db.curatedFindMany() },
    chatSession: { findFirst: () => db.sessionFindFirst(), create: () => db.sessionCreate(), update: async () => undefined },
  },
}));
vi.mock("./chat-sessions.js", () => ({ touchChatSession: async () => undefined }));

const { buildTip, pickTipPlace, placeTipGate, sendPlaceTips } = await import("./place-tips.js");
const { indexPlaces, resetPlaceCatalogCache, toPlaceFacts } = await import("./place-catalog.js");
const { placeTipsTick } = await import("../workers/place-tips.js");

const NOON = new Date("2026-11-26T10:00:00Z"); // 12:00 Kyiv
const DAY = 86_400_000;
const ZONE = "Europe/Kyiv";

function venue(id: string, over: Record<string, unknown> = {}) {
  return {
    id, placeId: `pl-${id}`, name: `Place ${id}`, address: "a", category: "cafe", priority: 1, lat: 50.45, lng: 30.52,
    utcOffsetMinutes: 120, openingHours: null, photoRefs: ["p"], rating: 4.5, userRatingCount: 100, priceLevel: null,
    vibeTags: [], facetTags: [], editorialSummary: null, primaryType: null, googleMapsUri: null, createdAt: new Date("2026-01-01"),
    ...over,
  };
}

describe("placeTipGate", () => {
  const tip = (daysAgo: number, answered: boolean) => ({ at: new Date(NOON.getTime() - daysAgo * DAY), answered, venueIds: [] });

  it("daytime, nothing before: yes", () => {
    expect(placeTipGate({ now: NOON, timeZone: ZONE, history: [] })).toEqual({ ok: true });
  });

  it("quiet hours and evenings: no", () => {
    expect(placeTipGate({ now: new Date("2026-11-26T23:00:00Z"), timeZone: ZONE, history: [] })).toEqual({ ok: false, reason: "night" });
    expect(placeTipGate({ now: new Date("2026-11-26T19:00:00Z"), timeZone: ZONE, history: [] })).toEqual({ ok: false, reason: "not_daytime" });
    expect(placeTipGate({ now: new Date("2026-11-26T07:30:00Z"), timeZone: ZONE, history: [] })).toEqual({ ok: false, reason: "not_daytime" });
  });

  it("at most once per three days", () => {
    expect(placeTipGate({ now: NOON, timeZone: ZONE, history: [tip(2.9, true)] })).toEqual({ ok: false, reason: "too_soon" });
    expect(placeTipGate({ now: NOON, timeZone: ZONE, history: [tip(3.1, true)] })).toEqual({ ok: true });
  });

  it("two ignored in a row: silence for 30 days", () => {
    expect(placeTipGate({ now: NOON, timeZone: ZONE, history: [tip(5, false), tip(9, false)] })).toEqual({ ok: false, reason: "ignored" });
    expect(placeTipGate({ now: NOON, timeZone: ZONE, history: [tip(31, false), tip(35, false)] })).toEqual({ ok: true });
    expect(placeTipGate({ now: NOON, timeZone: ZONE, history: [tip(5, false), tip(9, true)] })).toEqual({ ok: true });
  });
});

describe("pickTipPlace", () => {
  const regular = { anchorId: "pl-home-cafe", name: "Gym Café", category: "cafe", lat: 50.45, lng: 30.52, visits: 6 };
  const catalog = indexPlaces(
    "ua:kyiv",
    toPlaceFacts([
      venue("home-cafe"),
      venue("near", { lat: 50.452, rating: 4.4 }),
      venue("best", { lat: 50.453, rating: 4.9, userRatingCount: 900 }),
      venue("visited", { lat: 50.451, rating: 5, userRatingCount: 5000 }),
      venue("nophoto", { lat: 50.451, photoRefs: [], rating: 5 }),
      venue("far", { lat: 50.5, rating: 5, userRatingCount: 9000 }),
      venue("closed", { lat: 50.451, rating: 5, userRatingCount: 5000, openingHours: { periods: [{ open: { day: 4, hour: 18, minute: 0 }, close: { day: 4, hour: 23, minute: 0 } }] } }),
    ]),
  );

  it("near a regular, new to them, with a photo, not closed now; the best of those", () => {
    const pick = pickTipPlace({ catalog, regulars: [regular], visitedPlaceIds: new Set(["pl-visited"]), tippedVenueIds: new Set(), now: NOON });
    expect(pick?.place.id).toBe("best");
    expect(pick?.regular.name).toBe("Gym Café");
  });

  it("a place tipped before is never tipped again; nothing left → null", () => {
    expect(pickTipPlace({ catalog, regulars: [regular], visitedPlaceIds: new Set(["pl-visited"]), tippedVenueIds: new Set(["best"]), now: NOON })?.place.id).toBe("near");
    expect(pickTipPlace({ catalog, regulars: [regular], visitedPlaceIds: new Set(["pl-visited"]), tippedVenueIds: new Set(["best", "near"]), now: NOON })).toBeNull();
  });

  it("the tip: a regulars scene marked proactive and a line in their language", () => {
    const pick = pickTipPlace({ catalog, regulars: [regular], visitedPlaceIds: new Set(), tippedVenueIds: new Set(), now: NOON })!;
    const { scene, line } = buildTip(pick, [regular], "ru", NOON);
    expect(scene).toMatchObject({ kind: "place_scene", sceneKind: "regulars", proactive: true, title: "Новое рядом с твоими местами" });
    expect(scene.anchors).toEqual([{ label: "Gym Café", lat: 50.45, lng: 30.52, visits: 6 }]);
    expect(scene.subtitle).toMatch(/^\d+ мин от Gym Café$/);
    expect(line).toMatch(new RegExp(`^${pick.place.name} — в \\d+ мин от Gym Café, и это место для тебя новое\\.$`));
  });
});

describe("sendPlaceTips", () => {
  beforeEach(() => {
    resetPlaceCatalogCache();
    db.userFindMany.mockResolvedValue([{ id: USER, language: "uk", profile: { homeCityKey: "ua:kyiv", timeZone: null } }]);
    db.curatedFindMany.mockResolvedValue([venue("home-cafe"), venue("new", { lat: 50.452 })]);
    // Regulars read (last 60 days), then every place they ever visited.
    db.visitFindMany.mockImplementation(async (a: { distinct?: unknown }) =>
      a.distinct
        ? [{ placeId: "pl-home-cafe" }]
        : [
            { placeId: "pl-home-cafe", visitDay: new Date("2026-11-20") },
            { placeId: "pl-home-cafe", visitDay: new Date("2026-11-22") },
          ],
    );
    db.messageFindMany.mockResolvedValue([]);
  });

  it("an eligible person: one assistant row with the scene, one push to that chat", async () => {
    const push = vi.fn(async () => true);
    expect(await sendPlaceTips(NOON, { users: [USER], push })).toBe(1);
    const where = (db.userFindMany.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id: { in: [USER] }, frequentPlacesOptIn: true, notifyOnlyDates: false, platform: { in: ["mobile", "both"] } });
    const data = db.messageCreate.mock.calls.at(-1)![0].data as { role: string; sessionId: string; content: string; attachment: { venues: Array<{ id: string }>; proactive: boolean } };
    expect(data).toMatchObject({ role: "assistant", sessionId: "s-new" });
    expect(data.attachment.venues[0]!.id).toBe("new");
    expect(data.attachment.proactive).toBe(true);
    expect(data.content).toContain("Place new");
    expect(push).toHaveBeenCalledWith(USER, expect.objectContaining({ title: "Нове поруч із твоїми місцями", data: { type: "chat.reply", sessionId: "s-new" } }));
  });

  it("a tip two days ago: nothing", async () => {
    db.messageFindMany.mockResolvedValue([
      { createdAt: new Date(NOON.getTime() - 2 * DAY), attachment: { kind: "place_scene", sceneKind: "regulars", title: "x", proactive: true, venues: [{ id: "old", name: "Old", lat: 1, lng: 2 }] } },
    ]);
    db.messageFindFirst.mockResolvedValue({ id: "answer" });
    const push = vi.fn(async () => true);
    expect(await sendPlaceTips(NOON, { users: [USER], push })).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("at night: nothing", async () => {
    expect(await sendPlaceTips(new Date("2026-11-26T22:30:00Z"), { users: [USER], push: async () => true })).toBe(0);
  });

  it("frequent places switched off between the query and the read: nothing", async () => {
    db.userFindUnique.mockResolvedValueOnce({ frequentPlacesOptIn: false });
    expect(await sendPlaceTips(NOON, { users: [USER], push: async () => true })).toBe(0);
  });

  it("flag off, empty preview list: the tick reads nothing", async () => {
    db.userFindMany.mockClear();
    await placeTipsTick(NOON);
    expect(db.userFindMany).not.toHaveBeenCalled();
  });
});
