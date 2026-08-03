import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DATE_ALERT_HOURS,
  VENUE_CHANGE_TTL_HOURS,
} from "@gennety/shared";

vi.mock("@gennety/db", () => ({
  prisma: { curatedVenue: { findMany: vi.fn(async () => [] as unknown[]) } },
}));

vi.mock("./venue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./venue.js")>()),
  fetchPlacePhotoNames: vi.fn(async () => [] as string[] | null),
}));

import { prisma } from "@gennety/db";
import { fetchPlacePhotoNames } from "./venue.js";
import {
  evaluateVenueBoardEligibility,
  venueChangeCutoff,
  venueChangeDeadline,
  buildVenueChangeCatalog,
  listCuratedVenuesNear,
  capCatalog,
  VENUE_CHANGE_PREMIUM_PINNED,
  VENUE_CHANGE_PREMIUM_MAX,
  isWithinRadius,
  __resetVenuePhotoCacheForTests,
  type CatalogVenue,
  type VenueBoardEligibilityInput,
} from "./venue-change.js";

const findMany = prisma.curatedVenue.findMany as ReturnType<typeof vi.fn>;
const photoLookup = fetchPlacePhotoNames as ReturnType<typeof vi.fn>;

const HOUR = 60 * 60 * 1000;

function baseInput(
  over: Partial<VenueBoardEligibilityInput> = {},
): VenueBoardEligibilityInput {
  const now = new Date("2026-06-10T08:00:00Z");
  return {
    featureEnabled: true,
    status: "scheduled",
    callerUserId: "a",
    userAId: "a",
    userBId: "b",
    // 10h ahead → well before the T-5h cutoff
    agreedTime: new Date(now.getTime() + 10 * HOUR),
    venueLat: 50.45,
    venueLng: 30.52,
    venueChangeStatus: null,
    now,
    ...over,
  };
}

describe("evaluateVenueBoardEligibility (v2 — both sides)", () => {
  it("allows either participant before the cutoff", () => {
    expect(evaluateVenueBoardEligibility(baseInput())).toEqual({ ok: true, side: "A" });
    expect(evaluateVenueBoardEligibility(baseInput({ callerUserId: "b" }))).toEqual({
      ok: true,
      side: "B",
    });
  });

  it("blocks when the feature flag is off", () => {
    expect(evaluateVenueBoardEligibility(baseInput({ featureEnabled: false }))).toEqual({
      ok: false,
      reason: "feature-disabled",
    });
  });

  it("blocks a non-participant", () => {
    expect(evaluateVenueBoardEligibility(baseInput({ callerUserId: "z" }))).toEqual({
      ok: false,
      reason: "not-participant",
    });
  });

  it("stays interactive through liking and agreed sub-states", () => {
    expect(evaluateVenueBoardEligibility(baseInput({ venueChangeStatus: "liking" })).ok).toBe(true);
    expect(evaluateVenueBoardEligibility(baseInput({ venueChangeStatus: "agreed" })).ok).toBe(true);
  });

  it("closes for good once settled or lapsed (one settled change per date)", () => {
    expect(evaluateVenueBoardEligibility(baseInput({ venueChangeStatus: "settled" }))).toEqual({
      ok: false,
      reason: "already-changed",
    });
    expect(evaluateVenueBoardEligibility(baseInput({ venueChangeStatus: "lapsed" }))).toEqual({
      ok: false,
      reason: "already-changed",
    });
  });

  it("blocks when the match is not scheduled", () => {
    expect(evaluateVenueBoardEligibility(baseInput({ status: "negotiating" }))).toEqual({
      ok: false,
      reason: "wrong-state",
    });
  });

  it("blocks when there is no original venue center", () => {
    expect(
      evaluateVenueBoardEligibility(baseInput({ venueLat: null, venueLng: null })),
    ).toEqual({ ok: false, reason: "no-venue" });
  });

  it("blocks inside the T-5h critical zone", () => {
    const now = new Date("2026-06-10T08:00:00Z");
    // date only 4h away → now is past agreedTime - DATE_ALERT_HOURS(5h)
    const input = baseInput({ now, agreedTime: new Date(now.getTime() + 4 * HOUR) });
    expect(evaluateVenueBoardEligibility(input)).toEqual({
      ok: false,
      reason: "past-cutoff",
    });
  });

  it("blocks exactly at the cutoff", () => {
    const now = new Date("2026-06-10T08:00:00Z");
    const agreedTime = new Date(now.getTime() + DATE_ALERT_HOURS * HOUR); // cutoff == now
    expect(evaluateVenueBoardEligibility(baseInput({ now, agreedTime })).ok).toBe(false);
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

describe("listCuratedVenuesNear", () => {
  it("returns [] without querying when neither cityKey nor universityDomain is set", async () => {
    // A general/phone-track pair has no universityDomain; if the caller also
    // failed to resolve a cityKey, there is no scope to query by — this must
    // stay a fast no-op, not an unscoped (and unsafe) full-table read.
    const out = await listCuratedVenuesNear({
      cityKey: null,
      universityDomain: null,
      center: { lat: 50.45, lng: 30.52 },
      agreedTime: new Date("2026-06-10T16:00:00Z"),
    });
    expect(out).toEqual([]);
  });
});

describe("listCuratedVenuesNear — dedup + per-tier radius", () => {
  const CENTER = { lat: 50.45, lng: 30.52 };

  /** A curated row as Prisma hands it back, at `km` due north of CENTER. */
  function row(
    over: Partial<{
      placeId: string | null;
      name: string;
      address: string;
      tier: string;
      km: number;
      universityDomain: string;
    }> = {},
  ) {
    const km = over.km ?? 0.5;
    return {
      name: over.name ?? "Kava",
      address: over.address ?? "1 St",
      // ~111 km per degree of latitude — close enough for a radius assertion.
      lat: CENTER.lat + km / 111,
      lng: CENTER.lng,
      googleMapsUri: null,
      category: "cafe",
      tier: over.tier ?? "base",
      utcOffsetMinutes: 180,
      openingHours: null, // unknown hours are treated as open, never filtered
      placeId: over.placeId === undefined ? "place-1" : over.placeId,
      rating: 4.6,
      userRatingCount: 200,
      universityDomain: over.universityDomain ?? "knu.ua",
    };
  }

  const scope = {
    cityKey: "ua:kyiv",
    universityDomain: null,
    center: CENTER,
    agreedTime: new Date("2026-06-10T16:00:00Z"),
  };

  beforeEach(() => {
    findMany.mockReset();
  });

  it("collapses the per-university-domain copies of one venue into one card", async () => {
    // The production shape: Kyiv stores 538 active rows for 127 real venues,
    // five copies each. Before the dedup these sorted adjacently (identical
    // coordinates) and filled the pinned premium slots with the same place.
    findMany.mockResolvedValue(
      ["kneu.edu.ua", "knu.ua", "kpi.ua", "stud.nau.edu.ua", "ukma.edu.ua"].map((d) =>
        row({ universityDomain: d }),
      ),
    );

    const out = await listCuratedVenuesNear(scope);

    expect(out).toHaveLength(1);
    expect(out[0]!.placeId).toBe("place-1");
  });

  it("dedupes rows with no placeId by name + address, the board's own key", async () => {
    findMany.mockResolvedValue([
      row({ placeId: null, name: "Hand Entered", address: "9 St" }),
      row({ placeId: null, name: "Hand Entered", address: "9 St" }),
      row({ placeId: null, name: "Hand Entered", address: "11 St" }),
    ]);

    const out = await listCuratedVenuesNear(scope);

    expect(out.map((v) => v.address)).toEqual(["9 St", "11 St"]);
  });

  it("reaches further for premium than for base", async () => {
    findMany.mockResolvedValue([
      row({ placeId: "base-far", tier: "base", km: 4.2 }),
      row({ placeId: "prem-far", tier: "premium", km: 4.2 }),
      row({ placeId: "prem-too-far", tier: "premium", km: 5.4 }),
      row({ placeId: "alt-far", tier: "alternative", km: 4.2 }),
    ]);

    const out = await listCuratedVenuesNear(scope);

    // 4.2 km: inside the 5 km premium radius, outside the 3 km base one.
    expect(out.map((v) => v.placeId)).toEqual(["prem-far"]);
  });

  it("keeps every tier that is inside its own radius", async () => {
    findMany.mockResolvedValue([
      row({ placeId: "base-near", tier: "base", km: 2 }),
      row({ placeId: "prem-near", tier: "premium", km: 2.5 }),
      row({ placeId: "alt-near", tier: "alternative", km: 1 }),
    ]);

    const out = await listCuratedVenuesNear(scope);

    expect(out.map((v) => v.placeId)).toEqual(["alt-near", "base-near", "prem-near"]);
  });

  it("asks the database for the most recently verified copy first", async () => {
    // Which duplicate survives the dedup should be a decision, not an accident
    // of insertion order — the re-validation cron refreshes copies one by one.
    findMany.mockResolvedValue([]);

    await listCuratedVenuesNear(scope);

    expect(findMany.mock.calls[0]![0]).toMatchObject({
      orderBy: { lastVerifiedAt: { sort: "desc", nulls: "last" } },
    });
  });
});

describe("buildVenueChangeCatalog", () => {
  const input = {
    cityKey: null as string | null,
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
      tier: "base",
      distanceKm: 0.2,
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
      tier: "base",
      distanceKm: 0.3,
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

  it("drops the currently-assigned venue — it is the pinned KEEP card", async () => {
    // Otherwise the same place shows twice, and the two cards do different
    // things: KEEP_KEY keeps it for free, its own key takes the PAID path and
    // charges to "change" to the venue the pair already has.
    const out = await buildVenueChangeCatalog(
      { ...input, excludeVenue: { placeId: "c1", name: "Curated Cafe", address: "1 St" } },
      { listCurated: async () => curated },
    );
    expect(out).toEqual([]);
  });

  it("falls back to name + address when the assigned venue has no placeId", async () => {
    const out = await buildVenueChangeCatalog(
      { ...input, excludeVenue: { placeId: null, name: "Curated Cafe", address: "1 St" } },
      { listCurated: async () => curated },
    );
    expect(out).toEqual([]);
  });

  it("keeps a different venue that merely shares a name", async () => {
    const out = await buildVenueChangeCatalog(
      { ...input, excludeVenue: { placeId: "other", name: "Curated Cafe", address: "1 St" } },
      { listCurated: async () => curated },
    );
    expect(out.map((v) => v.placeId)).toEqual(["c1"]);
  });

  it("excludes before the cap, so the freed slot goes to a real alternative", async () => {
    const many: CatalogVenue[] = Array.from({ length: 13 }, (_, i) => ({
      ...curated[0]!,
      placeId: `c${i}`,
      name: `Venue ${i}`,
      distanceKm: i * 0.1,
    }));

    const out = await buildVenueChangeCatalog(
      { ...input, excludeVenue: { placeId: "c0", name: "Venue 0", address: "1 St" } },
      { listCurated: async () => many },
    );

    expect(out).toHaveLength(12);
    expect(out.map((v) => v.placeId)).not.toContain("c0");
    // c12 would have been cut by the cap had c0 taken a slot.
    expect(out.map((v) => v.placeId)).toContain("c12");
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

describe("capCatalog (§Premium pin + scatter)", () => {
  const venue = (i: number, tier: "base" | "premium" | "alternative"): CatalogVenue => ({
    source: "curated",
    placeId: `${tier}-${i}`,
    name: `${tier} ${i}`,
    address: `${i} St`,
    lat: 50.45,
    lng: 30.52,
    mapsUri: null,
    category: "cafe",
    tier,
    distanceKm: i * 0.1, // farther as i grows
    photoRefs: [],
    rating: null,
    userRatingCount: null,
    editorialSummary: null,
  });

  it("returns everything when under the cap", () => {
    const list = [venue(1, "base"), venue(2, "premium")];
    expect(capCatalog(list)).toHaveLength(2);
  });

  it("guarantees premium venues survive a dense base pool past the cap", () => {
    // 15 nearby base venues (0.1..1.5 km) then 2 farther premium (2.0, 2.1 km).
    const base = Array.from({ length: 15 }, (_, i) => venue(i + 1, "base"));
    const premium = [venue(20, "premium"), venue(21, "premium")];
    const capped = capCatalog([...base, ...premium]);
    expect(capped).toHaveLength(12);
    expect(capped.filter((v) => v.tier === "premium")).toHaveLength(2);
    // Premium leads even though it's farther away — grouped by tier, not
    // globally distance-sorted (§Premium conversion visibility).
    expect(capped.slice(0, 2).every((v) => v.tier === "premium")).toBe(true);
    expect(capped.slice(2).every((v) => v.tier === "base")).toBe(true);
  });

  it("pins premium first even when the whole list is well under the cap", () => {
    // A far premium venue (2.0 km) still leads three much nearer base ones.
    const list = [venue(1, "base"), venue(2, "base"), venue(3, "base"), venue(20, "premium")];
    const capped = capCatalog(list);
    expect(capped[0].tier).toBe("premium");
    expect(capped.slice(1).map((v) => v.distanceKm)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);
  });

  it("caps total premium at VENUE_CHANGE_PREMIUM_MAX so the board isn't a paywall wall", () => {
    const base = Array.from({ length: 12 }, (_, i) => venue(i + 1, "base"));
    const premium = Array.from({ length: 8 }, (_, i) => venue(30 + i, "premium"));
    const capped = capCatalog([...base, ...premium]);
    expect(capped).toHaveLength(12);
    expect(capped.filter((v) => v.tier === "premium").length).toBe(VENUE_CHANGE_PREMIUM_MAX);
  });

  it("pins exactly VENUE_CHANGE_PREMIUM_PINNED at the top and scatters the rest", () => {
    const base = Array.from({ length: 12 }, (_, i) => venue(i + 1, "base"));
    const premium = Array.from({ length: 5 }, (_, i) => venue(30 + i, "premium"));
    const capped = capCatalog([...base, ...premium], "match-seed");

    const head = capped.slice(0, VENUE_CHANGE_PREMIUM_PINNED);
    expect(head.every((v) => v.tier === "premium")).toBe(true);
    // The leftover premium lives in the tail, not stacked behind the pinned ones.
    const tail = capped.slice(VENUE_CHANGE_PREMIUM_PINNED);
    expect(tail.filter((v) => v.tier === "premium")).toHaveLength(
      VENUE_CHANGE_PREMIUM_MAX - VENUE_CHANGE_PREMIUM_PINNED,
    );
    expect(tail.every((v) => v.tier === "premium")).toBe(false);
  });

  it("is deterministic for a given seed and differs across seeds", () => {
    // The Mini App re-fetches the catalog (reopen, post-unlock repaint); an
    // unseeded shuffle would re-deal the cards under the user every time.
    const base = Array.from({ length: 12 }, (_, i) => venue(i + 1, "base"));
    const premium = Array.from({ length: 5 }, (_, i) => venue(30 + i, "premium"));
    const input = [...base, ...premium];

    const a1 = capCatalog(input, "match-1").map((v) => v.placeId);
    const a2 = capCatalog(input, "match-1").map((v) => v.placeId);
    const b1 = capCatalog(input, "match-2").map((v) => v.placeId);

    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b1);
  });

  it("falls back to plain distance order when no seed is given", () => {
    const base = Array.from({ length: 4 }, (_, i) => venue(i + 1, "base"));
    const capped = capCatalog(base);
    expect(capped.map((v) => v.placeId)).toEqual(["base-1", "base-2", "base-3", "base-4"]);
  });

  it("plain distance cap when there are no premium venues", () => {
    const base = Array.from({ length: 15 }, (_, i) => venue(i + 1, "base"));
    const capped = capCatalog(base);
    expect(capped).toHaveLength(12);
    expect(capped.every((v) => v.tier === "base")).toBe(true);
  });

  it("treats `alternative` as ordinary board inventory, not a reserved tier", () => {
    // The heavier-cuisine pool competes on distance like base — it is not
    // scarce, locked, or slot-reserved the way §Premium is.
    const alternative = Array.from({ length: 15 }, (_, i) => venue(i + 1, "alternative"));
    const capped = capCatalog(alternative);
    expect(capped).toHaveLength(12);
    expect(capped.every((v) => v.tier === "alternative")).toBe(true);
  });
});

describe("buildVenueChangeCatalog — curated cover photos", () => {
  const input = {
    cityKey: "ua:kyiv",
    universityDomain: null,
    center: { lat: 50.45, lng: 30.52 },
    agreedTime: new Date("2026-06-10T16:00:00Z"),
    withPhotos: true,
  };

  const curatedNoPhotos = (placeId: string | null): CatalogVenue => ({
    source: "curated",
    placeId,
    name: `Venue ${placeId ?? "x"}`,
    address: "1 St",
    lat: 50.451,
    lng: 30.521,
    mapsUri: null,
    category: "cafe",
    tier: "base",
    distanceKm: 0.2,
    photoRefs: [],
    rating: null,
    userRatingCount: null,
    editorialSummary: null,
  });

  beforeEach(() => {
    __resetVenuePhotoCacheForTests();
    photoLookup.mockReset();
    photoLookup.mockResolvedValue(["places/p/photos/a", "places/p/photos/b"]);
    process.env.PLACES_API_KEY = "test-places-key";
  });

  it("fills in photos for curated rows, which store none of their own", async () => {
    // The regression this exists for: once the catalog was scoped by cityKey the
    // curated branch started winning, and curated rows hardcode `photoRefs: []`
    // — so every board went photo-less by construction.
    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => [curatedNoPhotos("c1")],
    });

    expect(out[0]!.photoRefs).toEqual(["places/p/photos/a", "places/p/photos/b"]);
  });

  it("looks a place up once, however many boards ask for it", async () => {
    const deps = { listCurated: async () => [curatedNoPhotos("c1")] };

    await buildVenueChangeCatalog(input, deps);
    await buildVenueChangeCatalog(input, deps);

    expect(photoLookup).toHaveBeenCalledTimes(1);
  });

  it("never lets a failed lookup cost the board a card", async () => {
    photoLookup.mockResolvedValue(null);

    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => [curatedNoPhotos("c1")],
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.photoRefs).toEqual([]);
  });

  it("does not hammer Places while a lookup is failing", async () => {
    // A Places outage must not turn every board open into another request at a
    // service that is already struggling.
    photoLookup.mockResolvedValue(null);
    const deps = { listCurated: async () => [curatedNoPhotos("c1")] };

    await buildVenueChangeCatalog(input, deps);
    await buildVenueChangeCatalog(input, deps);

    expect(photoLookup).toHaveBeenCalledTimes(1);
  });

  it("retries a failure minutes later, not a day later like a success", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
      photoLookup.mockResolvedValueOnce(null).mockResolvedValueOnce(["places/p/photos/a"]);
      const deps = { listCurated: async () => [curatedNoPhotos("c1")] };

      await buildVenueChangeCatalog(input, deps);

      // Past the short failure window, well inside the day-long success one.
      vi.setSystemTime(new Date("2026-06-10T12:10:00Z"));
      const second = await buildVenueChangeCatalog(input, deps);
      expect(photoLookup).toHaveBeenCalledTimes(2);
      expect(second[0]!.photoRefs).toEqual(["places/p/photos/a"]);

      // The success that just landed is now cached for a day.
      vi.setSystemTime(new Date("2026-06-10T18:00:00Z"));
      await buildVenueChangeCatalog(input, deps);
      expect(photoLookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves rows that already carry photos alone (the Places fallback path)", async () => {
    const fromPlaces: CatalogVenue = {
      ...curatedNoPhotos("p1"),
      source: "places",
      photoRefs: ["places/p1/photos/original"],
    };

    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => [],
      listPlaces: async () => [fromPlaces],
    });

    expect(out[0]!.photoRefs).toEqual(["places/p1/photos/original"]);
    expect(photoLookup).not.toHaveBeenCalled();
  });

  it("skips a row with no placeId instead of guessing", async () => {
    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => [curatedNoPhotos(null)],
    });

    expect(out[0]!.photoRefs).toEqual([]);
    expect(photoLookup).not.toHaveBeenCalled();
  });

  it("makes no lookups at all without withPhotos — the like/confirm rebuilds", async () => {
    // Those paths only re-resolve a submitted key against the server's catalog.
    // They render nothing, so a Places round-trip would be pure added latency
    // on a user's tap.
    const out = await buildVenueChangeCatalog(
      { ...input, withPhotos: false },
      { listCurated: async () => [curatedNoPhotos("c1")] },
    );

    expect(out[0]!.photoRefs).toEqual([]);
    expect(photoLookup).not.toHaveBeenCalled();
  });

  it("degrades quietly when no Places key is configured", async () => {
    delete process.env.PLACES_API_KEY;

    const out = await buildVenueChangeCatalog(input, {
      listCurated: async () => [curatedNoPhotos("c1")],
    });

    expect(out).toHaveLength(1);
    expect(photoLookup).not.toHaveBeenCalled();
  });

  it("resolves photos only for the capped list, not the whole city catalog", async () => {
    const many = Array.from({ length: 30 }, (_, i) => curatedNoPhotos(`c${i}`));

    const out = await buildVenueChangeCatalog(input, { listCurated: async () => many });

    expect(out).toHaveLength(12);
    expect(photoLookup).toHaveBeenCalledTimes(12);
  });
});
