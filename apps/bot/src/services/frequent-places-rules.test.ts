/**
 * The pure half of frequently visited places: what one fix says, when fixes
 * become a visit, and how visits become the three places a profile shows.
 * Distances are built from metres so each case reads as the street it models.
 */
import { describe, expect, it } from "vitest";
import {
  FREQUENT_PLACE_MIN_DWELL_MINUTES,
  FREQUENT_PLACE_RULES,
  type FrequentPlaceCategory,
} from "@gennety/shared";

import {
  daysBetween,
  fencesFor,
  frequentPlaceScore,
  localDay,
  rankFrequentPlaces,
  readFix,
  shiftDay,
  stepPresence,
  type CatalogPlace,
  type FixReading,
  type Presence,
  type VisitDay,
} from "./frequent-places-rules.js";

interface Point {
  lat: number;
  lng: number;
}

const ORIGIN: Point = { lat: 50.4501, lng: 30.5234 };
const METRES_PER_DEGREE = 111_320;

/** A point `north` and `east` metres away from `from`. */
function offset(from: Point, north: number, east: number): Point {
  return {
    lat: from.lat + north / METRES_PER_DEGREE,
    lng: from.lng + east / (METRES_PER_DEGREE * Math.cos((from.lat * Math.PI) / 180)),
  };
}

function place(placeId: string, category: FrequentPlaceCategory, at: Point): CatalogPlace {
  return { placeId, name: placeId, category, lat: at.lat, lng: at.lng };
}

describe("readFix — one fix against the catalog", () => {
  const cafe = place("cafe", "cafe", ORIGIN);
  const museum = place("museum", "museum", offset(ORIGIN, 400, 0));

  it("reads a fix inside a place's radius as that place", () => {
    expect(readFix({ ...offset(ORIGIN, 20, 0), accuracyM: 10 }, [cafe, museum])).toEqual({
      kind: "place",
      placeId: "cafe",
      category: "cafe",
    });
  });

  it("reads a fix just outside the radius, but within its own error of it, as unclear — not as leaving", () => {
    // 45 m from a 35 m café with ±20 m: that can be the terrace.
    expect(readFix({ ...offset(ORIGIN, 45, 0), accuracyM: 20 }, [cafe])).toEqual({
      kind: "unclear",
    });
  });

  it("reads a fix clear of every place as away", () => {
    expect(readFix({ ...offset(ORIGIN, 200, 0), accuracyM: 10 }, [cafe, museum])).toEqual({
      kind: "away",
    });
  });

  it("refuses to read a vague or broken fix at all", () => {
    expect(readFix({ ...ORIGIN, accuracyM: 51 }, [cafe])).toEqual({ kind: "unclear" });
    expect(readFix({ ...ORIGIN, accuracyM: -1 }, [cafe])).toEqual({ kind: "unclear" });
    expect(readFix({ lat: Number.NaN, lng: 30, accuracyM: 5 }, [cafe])).toEqual({
      kind: "unclear",
    });
  });

  it("uses each category's own radius — a museum reaches further than a café", () => {
    const at = { ...offset(museum, 45, 0), accuracyM: 15 };
    expect(readFix(at, [museum])).toMatchObject({ kind: "place", placeId: "museum" });
    expect(readFix(at, [place("cafe-there", "cafe", museum)])).toEqual({ kind: "unclear" });
  });

  it("counts for neither of two places too close to tell apart", () => {
    // A street of shopfronts: two cafés 10 m apart, the fix between them.
    const left = place("left", "cafe", ORIGIN);
    const right = place("right", "cafe", offset(ORIGIN, 0, 10));
    expect(readFix({ ...offset(ORIGIN, 0, 4), accuracyM: 8 }, [left, right])).toEqual({
      kind: "unclear",
    });
  });

  it("still names the nearer place when the neighbour is clearly further", () => {
    const left = place("left", "cafe", ORIGIN);
    const right = place("right", "cafe", offset(ORIGIN, 0, 40));
    expect(readFix({ ...offset(ORIGIN, 0, 2), accuracyM: 8 }, [left, right])).toMatchObject({
      kind: "place",
      placeId: "left",
    });
  });

  it("counts a neighbour toward ambiguity even when the fix is outside the neighbour's circle", () => {
    // Inside the first café's circle at 30 m, but a second café is 38 m away:
    // the dot is between them, whichever circle it happens to land in.
    const inside = place("inside", "cafe", ORIGIN);
    const beyond = place("beyond", "cafe", offset(ORIGIN, 68, 0));
    expect(readFix({ ...offset(ORIGIN, 30, 0), accuracyM: 5 }, [inside, beyond])).toEqual({
      kind: "unclear",
    });
  });
});

describe("fencesFor — the client's pre-filter", () => {
  it("hands the client the server's own radii, so the two cannot disagree", () => {
    expect(fencesFor([place("c", "cafe", ORIGIN), place("m", "museum", ORIGIN)])).toEqual([
      { ...ORIGIN, radiusM: FREQUENT_PLACE_RULES.cafe.radiusM },
      { ...ORIGIN, radiusM: FREQUENT_PLACE_RULES.museum.radiusM },
    ]);
  });
});

describe("stepPresence — from fixes to a visit", () => {
  const T0 = Date.parse("2026-09-11T12:00:00Z");
  const MINUTE = 60_000;
  const at = (minutes: number): number => T0 + minutes * MINUTE;
  const dayOf = (instant: number): string => localDay(instant, "Europe/Kyiv");
  const atCafe: FixReading = { kind: "place", placeId: "cafe", category: "cafe" };
  const atMuseum: FixReading = { kind: "place", placeId: "museum", category: "museum" };

  function run(steps: Array<[number, FixReading]>): {
    presence: Presence | null;
    visits: Array<{ placeId: string; day: string }>;
  } {
    let presence: Presence | null = null;
    const visits: Array<{ placeId: string; day: string }> = [];
    for (const [minutes, reading] of steps) {
      const step = stepPresence(presence, reading, at(minutes), dayOf);
      presence = step.presence;
      if (step.visit) visits.push(step.visit);
    }
    return { presence, visits };
  }

  it("never counts a single fix — one ping is walking past until proven otherwise", () => {
    expect(run([[0, atCafe]]).visits).toEqual([]);
  });

  it("does not count two fixes closer together than the dwell", () => {
    expect(
      run([
        [0, atCafe],
        [FREQUENT_PLACE_MIN_DWELL_MINUTES - 1, atCafe],
      ]).visits,
    ).toEqual([]);
  });

  it("counts a stay once two fixes at one place are the dwell apart", () => {
    expect(
      run([
        [0, atCafe],
        [FREQUENT_PLACE_MIN_DWELL_MINUTES, atCafe],
      ]).visits,
    ).toEqual([{ placeId: "cafe", day: "2026-09-11" }]);
  });

  it("does not bridge a departure: leaving and walking past again is two pass-bys", () => {
    expect(
      run([
        [0, atCafe],
        [5, { kind: "away" }],
        [20, atCafe],
      ]).visits,
    ).toEqual([]);
  });

  it("lets an unclear fix neither break a stay nor stretch it", () => {
    const opened = run([
      [0, atCafe],
      [8, { kind: "unclear" }],
    ]).presence;
    expect(opened?.lastAt).toBe(at(0));

    expect(
      run([
        [0, atCafe],
        [8, { kind: "unclear" }],
        [16, atCafe],
      ]).visits,
    ).toHaveLength(1);
  });

  it("does not bridge a silence longer than the category allows", () => {
    const gap = FREQUENT_PLACE_RULES.cafe.maxGapMinutes;
    expect(
      run([
        [0, atCafe],
        [gap + 1, atCafe],
      ]).visits,
    ).toEqual([]);
    expect(
      run([
        [0, atCafe],
        [gap, atCafe],
      ]).visits,
    ).toHaveLength(1);
  });

  it("gives a museum the longer silence a museum visit has", () => {
    expect(
      run([
        [0, atMuseum],
        [150, atMuseum],
      ]).visits,
    ).toEqual([{ placeId: "museum", day: "2026-09-11" }]);
    expect(
      run([
        [0, atCafe],
        [150, atCafe],
      ]).visits,
    ).toEqual([]);
  });

  it("starts over at a different place", () => {
    expect(
      run([
        [0, atCafe],
        [20, atMuseum],
      ]).visits,
    ).toEqual([]);
  });

  it("writes a long stay once, not once per fix", () => {
    expect(
      run([
        [0, atCafe],
        [20, atCafe],
        [40, atCafe],
        [60, atCafe],
      ]).visits,
    ).toHaveLength(1);
  });

  it("ignores a fix that is not newer than the last one — a retry, or a cached position sent again", () => {
    const opened = stepPresence(null, atCafe, at(10), dayOf).presence;
    expect(stepPresence(opened, { kind: "away" }, at(10), dayOf)).toEqual({
      presence: opened,
      visit: null,
    });
    expect(stepPresence(opened, atCafe, at(-5), dayOf)).toEqual({ presence: opened, visit: null });
  });

  it("dates a visit by the local day of the fix that completed it", () => {
    // 23:50 → 00:10 in Kyiv (UTC+3 in September) is 20:50 → 21:10 UTC.
    const start = Date.parse("2026-09-11T20:50:00Z");
    const first = stepPresence(null, atCafe, start, dayOf);
    const second = stepPresence(first.presence, atCafe, start + 20 * MINUTE, dayOf);
    expect(second.visit).toEqual({ placeId: "cafe", day: "2026-09-12" });
  });
});

describe("days", () => {
  it("names the local calendar day, not the UTC one", () => {
    expect(localDay(Date.parse("2026-09-10T21:30:00Z"), "Europe/Kyiv")).toBe("2026-09-11");
    expect(localDay(Date.parse("2026-09-10T20:30:00Z"), "Europe/Kyiv")).toBe("2026-09-10");
  });

  it("counts and shifts whole days across a month end", () => {
    expect(daysBetween("2026-09-01", "2026-09-11")).toBe(10);
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("frequentPlaceScore", () => {
  const TODAY = "2026-09-11";
  const today = (count: number): string[] => Array.from({ length: count }, () => TODAY);

  it("puts every category at 1 × its weight on its own threshold", () => {
    expect(frequentPlaceScore("cafe", today(5), TODAY)).toBeCloseTo(1);
    expect(frequentPlaceScore("museum", today(3), TODAY)).toBeCloseTo(1.3);
  });

  it("halves a visit's weight every half-life", () => {
    expect(frequentPlaceScore("cafe", [shiftDay(TODAY, -45)], TODAY)).toBeCloseTo(0.5 / 5);
  });
});

describe("rankFrequentPlaces — thresholds and order", () => {
  const TODAY = "2026-09-11";
  const catalog = new Map<string, CatalogPlace>(
    (
      [
        ["cafe-a", "cafe"],
        ["cafe-b", "cafe"],
        ["cafe-c", "cafe"],
        ["museum", "museum"],
        ["rest", "restaurant"],
        ["lounge", "lounge"],
      ] as const
    ).map(([id, category]) => [id, place(id, category, ORIGIN)]),
  );

  /** `count` visits to `placeId`, one a day, the latest `endAgo` days ago. */
  function visitsTo(placeId: string, count: number, endAgo = 0): VisitDay[] {
    return Array.from({ length: count }, (_, i) => ({
      placeId,
      day: shiftDay(TODAY, -(endAgo + i)),
    }));
  }

  function rank(visits: VisitDay[], hidden: string[] = []) {
    return rankFrequentPlaces({ visits, places: catalog, hidden: new Set(hidden), today: TODAY });
  }

  const ids = (places: Array<{ placeId: string }>): string[] => places.map((p) => p.placeId);

  it("lets a café in only past four visits", () => {
    expect(rank(visitsTo("cafe-a", 4)).shown).toEqual([]);
    expect(ids(rank(visitsTo("cafe-a", 5)).shown)).toEqual(["cafe-a"]);
  });

  it("lets a museum in at three", () => {
    expect(rank(visitsTo("museum", 2)).shown).toEqual([]);
    expect(rank(visitsTo("museum", 3)).shown).toEqual([
      { placeId: "museum", name: "museum", category: "museum", visits: 3, hidden: false },
    ]);
  });

  it("counts a day once, however many times it was reported", () => {
    const oneDay = Array.from({ length: 6 }, () => ({ placeId: "cafe-a", day: TODAY }));
    expect(rank(oneDay).shown).toEqual([]);
  });

  it("forgets visits older than the window", () => {
    // Five visits whose oldest is 180 days back: only four are inside.
    expect(rank(visitsTo("cafe-a", 5, 176)).shown).toEqual([]);
    expect(rank(visitsTo("cafe-a", 5, 175)).shown).toHaveLength(1);
  });

  it("puts the less routine category first when both sit at their thresholds", () => {
    expect(ids(rank([...visitsTo("cafe-a", 5), ...visitsTo("museum", 3)]).shown)).toEqual([
      "museum",
      "cafe-a",
    ]);
  });

  it("puts this month's café above the spring's, even with fewer visits", () => {
    expect(ids(rank([...visitsTo("cafe-a", 7, 120), ...visitsTo("cafe-b", 5)]).shown)).toEqual([
      "cafe-b",
      "cafe-a",
    ]);
  });

  it("promotes the next place when one is hidden, and keeps the hidden one for its owner", () => {
    const visits = [
      ...visitsTo("museum", 3),
      ...visitsTo("cafe-a", 6),
      ...visitsTo("rest", 5),
      ...visitsTo("lounge", 5),
    ];
    expect(ids(rank(visits).shown)).toEqual(["museum", "cafe-a", "lounge"]);

    const withHidden = rank(visits, ["cafe-a"]);
    expect(ids(withHidden.shown)).toEqual(["museum", "lounge", "rest"]);
    expect(withHidden.hidden).toEqual([
      { placeId: "cafe-a", name: "cafe-a", category: "cafe", visits: 6, hidden: true },
    ]);
  });

  it("shows at most two places of one category", () => {
    const visits = [
      ...visitsTo("cafe-a", 8),
      ...visitsTo("cafe-b", 7),
      ...visitsTo("cafe-c", 6),
      ...visitsTo("rest", 5),
    ];
    expect(ids(rank(visits).shown)).toEqual(["cafe-a", "cafe-b", "rest"]);
  });

  it("never shows a place the catalog does not hold", () => {
    expect(rank(visitsTo("places-fallback-venue", 9)).shown).toEqual([]);
  });

  it("orders equal places the same way every time", () => {
    const visits = [...visitsTo("rest", 5), ...visitsTo("lounge", 5)];
    expect(ids(rank(visits).shown)).toEqual(["lounge", "rest"]);
    expect(ids(rank([...visits].reverse()).shown)).toEqual(["lounge", "rest"]);
  });
});
