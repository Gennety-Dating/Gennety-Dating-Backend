import { describe, expect, it } from "vitest";
import {
  AFTER_DATE_RADIUS_M,
  afterDateKindFor,
  afterDatePlaceView,
  pickAfterDatePlace,
  type AfterDateCandidateRow,
} from "./venue-after-date.js";

const VENUE = { placeId: "ChIJ-venue", lat: 50.45, lng: 30.52 };
const DATE_END = new Date("2026-09-26T16:30:00.000Z");
const openAlways = () => true;

/** ~`meters` north of the venue. */
function north(meters: number): { lat: number; lng: number } {
  return { lat: VENUE.lat + meters / 111_320, lng: VENUE.lng };
}

function row(id: string, category: string, meters: number, over: Partial<AfterDateCandidateRow> = {}) {
  return {
    id,
    placeId: `ChIJ-${id}`,
    name: id,
    ...north(meters),
    category,
    priority: 2,
    hoursConfidence: "always_open",
    openingHours: null,
    utcOffsetMinutes: 180,
    ...over,
  } satisfies AfterDateCandidateRow;
}

describe("afterDateKindFor", () => {
  it("walks with an active lead, sits with a calm one, and stays silent otherwise", () => {
    expect(afterDateKindFor("active")).toBe("stroll");
    expect(afterDateKindFor("calm")).toBe("treat");
    expect(afterDateKindFor("moderate")).toBeNull();
    expect(afterDateKindFor(null)).toBeNull();
  });
});

describe("pickAfterDatePlace", () => {
  it("takes the nearest place of the right kind inside the radius", () => {
    const rows = [row("far-park", "park", 700), row("near-park", "park", 200), row("cafe", "cafe", 50)];
    const pick = pickAfterDatePlace("stroll", VENUE, rows, DATE_END, openAlways);
    expect(pick).toMatchObject({ forVenuePlaceId: "ChIJ-venue", name: "near-park", walkMinutes: 3 });
  });

  it("offers a café, never a park, to a calm lead", () => {
    const rows = [row("park", "park", 50), row("coffee", "coffee_shop", 300)];
    expect(pickAfterDatePlace("treat", VENUE, rows, DATE_END, openAlways)?.name).toBe("coffee");
  });

  it("ignores anything past the radius and the date venue itself", () => {
    const rows = [
      row("too-far", "park", AFTER_DATE_RADIUS_M + 50),
      row("venue", "park", 0, { placeId: VENUE.placeId }),
    ];
    expect(pickAfterDatePlace("stroll", VENUE, rows, DATE_END, openAlways)).toBeNull();
  });

  it("skips a place that is closed when the date ends", () => {
    const rows = [row("closed", "cafe", 100), row("open", "cafe", 400)];
    const openAt = (candidate: AfterDateCandidateRow, at: Date) =>
      candidate.id !== "closed" && at.getTime() === DATE_END.getTime();
    expect(pickAfterDatePlace("treat", VENUE, rows, DATE_END, openAt)?.name).toBe("open");
  });
});

describe("afterDatePlaceView", () => {
  const stored = {
    forVenuePlaceId: "ChIJ-venue",
    placeId: "ChIJ-park",
    name: "Park",
    lat: 50.451,
    lng: 30.52,
    walkMinutes: 2,
  };

  it("serves the place without the venue key or any reason", () => {
    expect(afterDatePlaceView(stored, "ChIJ-venue")).toEqual({
      name: "Park",
      lat: 50.451,
      lng: 30.52,
      walkMinutes: 2,
    });
  });

  it("retires silently once the match points at another venue", () => {
    expect(afterDatePlaceView(stored, "ChIJ-other")).toBeNull();
    expect(afterDatePlaceView(stored, null)).toBeNull();
  });

  it("treats a malformed row as absent", () => {
    expect(afterDatePlaceView(null, "ChIJ-venue")).toBeNull();
    expect(afterDatePlaceView({ ...stored, name: 3 }, "ChIJ-venue")).toBeNull();
  });
});
