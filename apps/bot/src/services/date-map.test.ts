import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindMany = vi.fn();
const curatedFindMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findMany: matchFindMany },
    curatedVenue: { findMany: curatedFindMany },
  },
}));

const { groupPlaces, readAttendedPlaceIds, readDateMap, topVibes, DATE_MAP_TOP_VIBES } =
  await import("./date-map.js");

function date(overrides: Partial<{
  agreedTime: Date;
  venueName: string | null;
  venuePlaceId: string | null;
  venueLat: number | null;
  venueLng: number | null;
  venueMidpointLat: number | null;
}> = {}) {
  return {
    agreedTime: new Date("2026-09-20T17:00:00Z"),
    venueName: "Takava",
    venuePlaceId: "p-takava",
    venueLat: 50.45,
    venueLng: 30.52,
    venueMidpointLat: 50.44,
    ...overrides,
  };
}

beforeEach(() => {
  matchFindMany.mockReset().mockResolvedValue([]);
  curatedFindMany.mockReset().mockResolvedValue([]);
});

describe("groupPlaces", () => {
  it("folds repeat dates at one place into visits and keeps the newest date", () => {
    const places = groupPlaces(
      [
        date({ agreedTime: new Date("2026-09-25T17:00:00Z") }),
        date({ agreedTime: new Date("2026-09-10T17:00:00Z") }),
      ],
      new Map(),
    );

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ placeId: "p-takava", visits: 2 });
    expect(places[0]!.lastDateAt.toISOString()).toBe("2026-09-25T17:00:00.000Z");
  });

  it("keys a place without an id by its name, case-insensitively", () => {
    const places = groupPlaces(
      [
        date({ venuePlaceId: null, venueName: "Kyivska Perepichka" }),
        date({ venuePlaceId: null, venueName: "kyivska perepichka" }),
      ],
      new Map(),
    );

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ placeId: null, visits: 2 });
  });

  it("never offers a legacy route midpoint as the venue's point", () => {
    const [place] = groupPlaces([date({ venueMidpointLat: null })], new Map());

    expect(place).toMatchObject({ lat: null, lng: null });
  });

  it("skips a date with no venue name — there is nothing to put on the map", () => {
    expect(groupPlaces([date({ venueName: "  " })], new Map())).toEqual([]);
  });

  it("translates operator vibe tags into canonical experiences", () => {
    const [place] = groupPlaces([date()], new Map([["p-takava", ["coffee", "podil"]]]));

    expect(place!.experiences).toEqual(["coffee_treats"]);
  });
});

describe("topVibes", () => {
  it("weights an experience by dates spent there and keeps the top few", () => {
    const places = groupPlaces(
      [
        date({ venuePlaceId: "a" }),
        date({ venuePlaceId: "a" }),
        date({ venuePlaceId: "b", venueName: "Wine bar" }),
      ],
      new Map([
        ["a", ["coffee", "books"]],
        ["b", ["wine", "books"]],
      ]),
    );

    const vibes = topVibes(places);

    expect(vibes[0]).toEqual({ experience: "art_culture", dates: 3 });
    expect(vibes).toContainEqual({ experience: "coffee_treats", dates: 2 });
    expect(vibes.length).toBeLessThanOrEqual(DATE_MAP_TOP_VIBES);
  });
});

describe("readDateMap", () => {
  it("asks only for held dates this side attended, up to now", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    await readDateMap("me", now);

    const where = matchFindMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ["scheduled", "completed"] });
    expect(where.agreedTime).toEqual({ lte: now });
    expect(where.OR).toEqual([
      { userAId: "me", dateAttendedA: true },
      { userBId: "me", dateAttendedB: true },
    ]);
  });

  it("counts every confirmed date, even one with no named venue", async () => {
    matchFindMany.mockResolvedValue([date(), date({ venueName: null, venuePlaceId: null })]);
    curatedFindMany.mockResolvedValue([{ placeId: "p-takava", vibeTags: ["coffee"] }]);

    const map = await readDateMap("me");

    expect(map.confirmedDates).toBe(2);
    expect(map.places).toHaveLength(1);
    expect(map.vibes).toEqual([{ experience: "coffee_treats", dates: 1 }]);
  });

  it("does not touch the catalog when no date has a place id", async () => {
    matchFindMany.mockResolvedValue([date({ venuePlaceId: null })]);

    await readDateMap("me");

    expect(curatedFindMany).not.toHaveBeenCalled();
  });
});

describe("readAttendedPlaceIds", () => {
  it("answers the place ids of confirmed dates", async () => {
    matchFindMany.mockResolvedValue([date(), date({ venuePlaceId: null })]);

    expect(await readAttendedPlaceIds("me")).toEqual(new Set(["p-takava"]));
  });

  it("answers an empty set rather than throwing", async () => {
    matchFindMany.mockRejectedValue(new Error("db down"));

    expect(await readAttendedPlaceIds("me")).toEqual(new Set());
  });
});
