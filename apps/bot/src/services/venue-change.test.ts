import { describe, expect, it } from "vitest";
import {
  DATE_ALERT_HOURS,
  VENUE_CHANGE_TTL_HOURS,
} from "@gennety/shared";
import {
  evaluateVenueChangeEligibility,
  venueChangeCutoff,
  venueChangeDeadline,
  buildVenueChangeCatalog,
  isWithinRadius,
  type CatalogVenue,
  type VenueChangeEligibilityInput,
} from "./venue-change.js";

const HOUR = 60 * 60 * 1000;

function baseInput(
  over: Partial<VenueChangeEligibilityInput> = {},
): VenueChangeEligibilityInput {
  const now = new Date("2026-06-10T08:00:00Z");
  return {
    featureEnabled: true,
    status: "scheduled",
    callerUserId: "a",
    userAId: "a",
    userBId: "b",
    genderA: "female",
    genderB: "male",
    // 10h ahead → well before the T-5h cutoff
    agreedTime: new Date(now.getTime() + 10 * HOUR),
    venueLat: 50.45,
    venueLng: 30.52,
    venueChangeProposedAt: null,
    now,
    ...over,
  };
}

describe("evaluateVenueChangeEligibility", () => {
  it("allows the female participant before the cutoff", () => {
    expect(evaluateVenueChangeEligibility(baseInput())).toEqual({ ok: true, side: "A" });
  });

  it("blocks when the feature flag is off", () => {
    expect(evaluateVenueChangeEligibility(baseInput({ featureEnabled: false }))).toEqual({
      ok: false,
      reason: "feature-disabled",
    });
  });

  it("blocks a non-participant", () => {
    expect(evaluateVenueChangeEligibility(baseInput({ callerUserId: "z" }))).toEqual({
      ok: false,
      reason: "not-participant",
    });
  });

  it("blocks the male side in a hetero pair", () => {
    expect(
      evaluateVenueChangeEligibility(baseInput({ callerUserId: "b" })),
    ).toEqual({ ok: false, reason: "not-female-initiator" });
  });

  it("makes the feature unavailable to a male–male pair", () => {
    const mm = baseInput({ genderA: "male", genderB: "male" });
    expect(evaluateVenueChangeEligibility({ ...mm, callerUserId: "a" }).ok).toBe(false);
    expect(evaluateVenueChangeEligibility({ ...mm, callerUserId: "b" }).ok).toBe(false);
  });

  it("allows either side in a female–female pair (first-tap-wins via one-shot guard)", () => {
    const ff = baseInput({ genderA: "female", genderB: "female" });
    expect(evaluateVenueChangeEligibility({ ...ff, callerUserId: "a" })).toEqual({
      ok: true,
      side: "A",
    });
    expect(evaluateVenueChangeEligibility({ ...ff, callerUserId: "b" })).toEqual({
      ok: true,
      side: "B",
    });
  });

  it("blocks once a change has already been proposed (one-shot)", () => {
    expect(
      evaluateVenueChangeEligibility(baseInput({ venueChangeProposedAt: new Date() })),
    ).toEqual({ ok: false, reason: "already-used" });
  });

  it("blocks when the match is not scheduled", () => {
    expect(evaluateVenueChangeEligibility(baseInput({ status: "negotiating" }))).toEqual({
      ok: false,
      reason: "wrong-state",
    });
  });

  it("blocks when there is no original venue center", () => {
    expect(
      evaluateVenueChangeEligibility(baseInput({ venueLat: null, venueLng: null })),
    ).toEqual({ ok: false, reason: "no-venue" });
  });

  it("blocks inside the T-5h critical zone", () => {
    const now = new Date("2026-06-10T08:00:00Z");
    // date only 4h away → now is past agreedTime - DATE_ALERT_HOURS(5h)
    const input = baseInput({ now, agreedTime: new Date(now.getTime() + 4 * HOUR) });
    expect(evaluateVenueChangeEligibility(input)).toEqual({
      ok: false,
      reason: "past-cutoff",
    });
  });

  it("allows exactly at the cutoff minus a moment, blocks at the cutoff", () => {
    const now = new Date("2026-06-10T08:00:00Z");
    const agreedTime = new Date(now.getTime() + DATE_ALERT_HOURS * HOUR); // cutoff == now
    expect(evaluateVenueChangeEligibility(baseInput({ now, agreedTime })).ok).toBe(false);
  });
});

describe("venueChangeCutoff / venueChangeDeadline", () => {
  it("cutoff is agreedTime minus DATE_ALERT_HOURS", () => {
    const agreed = new Date("2026-06-10T20:00:00Z");
    expect(venueChangeCutoff(agreed).getTime()).toBe(
      agreed.getTime() - DATE_ALERT_HOURS * HOUR,
    );
  });

  it("deadline is min(now+TTL, cutoff) — TTL wins when the date is far off", () => {
    const now = new Date("2026-06-10T08:00:00Z");
    const agreed = new Date(now.getTime() + 48 * HOUR); // cutoff far in the future
    expect(venueChangeDeadline(now, agreed).getTime()).toBe(
      now.getTime() + VENUE_CHANGE_TTL_HOURS * HOUR,
    );
  });

  it("deadline is min(now+TTL, cutoff) — cutoff wins when the date is soon", () => {
    const now = new Date("2026-06-10T08:00:00Z");
    const agreed = new Date(now.getTime() + 7 * HOUR); // cutoff = now+2h < now+12h
    expect(venueChangeDeadline(now, agreed).getTime()).toBe(
      venueChangeCutoff(agreed).getTime(),
    );
  });
});

describe("isWithinRadius", () => {
  const center = { lat: 50.45, lng: 30.52 };
  it("accepts a point within 3 km", () => {
    expect(isWithinRadius(center, { lat: 50.46, lng: 30.53 })).toBe(true);
  });
  it("rejects a point well beyond 3 km", () => {
    expect(isWithinRadius(center, { lat: 50.6, lng: 30.9 })).toBe(false);
  });
});

describe("buildVenueChangeCatalog", () => {
  const input = {
    universityDomain: "kyiv.edu",
    center: { lat: 50.45, lng: 30.52 },
    agreedTime: new Date("2026-06-10T16:00:00Z"),
  };

  const curated: CatalogVenue[] = [
    {
      source: "curated",
      placeId: "c1",
      name: "Curated Cafe",
      address: "1 St",
      lat: 50.451,
      lng: 30.521,
      mapsUri: null,
      category: "cafe",
      distanceKm: 0.2,
      photoUrl: "https://img/c1.jpg",
      photoRefs: [],
      rating: null,
      userRatingCount: null,
      editorialSummary: null,
    },
  ];
  const places: CatalogVenue[] = [
    {
      source: "places",
      placeId: "p1",
      name: "Places Cafe",
      address: "2 St",
      lat: 50.452,
      lng: 30.522,
      mapsUri: null,
      category: "cafe",
      distanceKm: 0.3,
      photoUrl: null,
      photoRefs: ["places/p1/photos/x"],
      rating: 4.5,
      userRatingCount: 120,
      editorialSummary: "A cosy spot.",
    },
  ];

  it("returns curated rows when any qualify (no Places call)", async () => {
    let placesCalled = false;
    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => curated,
      listPlaces: async () => {
        placesCalled = true;
        return places;
      },
    });
    expect(out).toEqual(curated);
    expect(placesCalled).toBe(false);
  });

  it("falls back to Places when no curated row qualifies", async () => {
    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => [],
      listPlaces: async () => places,
    });
    expect(out).toEqual(places);
  });

  it("caps the list length", async () => {
    const many: CatalogVenue[] = Array.from({ length: 30 }, (_, i) => ({
      ...curated[0],
      placeId: `c${i}`,
      distanceKm: i * 0.1,
    }));
    const out = await buildVenueChangeCatalog(input, { listCurated: async () => many });
    expect(out.length).toBe(12);
  });
});
