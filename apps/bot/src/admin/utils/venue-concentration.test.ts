import { describe, expect, it } from "vitest";
import {
  computeVenueConcentration,
  normalizeFailureReason,
  parsePoolSizes,
  UNKNOWN_CITY_KEY,
  type SelectionLogRow,
} from "./venue-concentration.js";

function row(over: Partial<SelectionLogRow> = {}): SelectionLogRow {
  return {
    cityKey: "ua:kyiv",
    selectedPlaceId: "place-a",
    failureReason: null,
    poolSizes: null,
    ...over,
  };
}

describe("parsePoolSizes", () => {
  it("reads the funnel from the current shape", () => {
    const parsed = parsePoolSizes({
      candidates: [{ placeId: "x", score: {} }],
      poolSizes: { curatedInBox: 120, curatedEligible: 80, placesAdded: 5, ranked: 85 },
    });
    expect(parsed).toEqual({ curatedInBox: 120, curatedEligible: 80, placesAdded: 5, ranked: 85 });
  });

  it("returns null for the legacy bare-array shape rather than zeros", () => {
    // Rows written before part 6 stored `topCandidates` as a plain array. If
    // those parsed as a zeroed funnel they would drag the median to 0 and fake
    // a pool collapse that never happened.
    expect(parsePoolSizes([{ placeId: "x", score: 1 }])).toBeNull();
  });

  it("returns null for malformed or partial funnels", () => {
    expect(parsePoolSizes(null)).toBeNull();
    expect(parsePoolSizes({})).toBeNull();
    expect(parsePoolSizes({ poolSizes: { curatedInBox: 1 } })).toBeNull();
    expect(parsePoolSizes({ poolSizes: { curatedInBox: "1", curatedEligible: 1, placesAdded: 1, ranked: 1 } })).toBeNull();
    expect(parsePoolSizes({ poolSizes: { curatedInBox: NaN, curatedEligible: 1, placesAdded: 1, ranked: 1 } })).toBeNull();
  });

  it("accepts a zero funnel written by a genuinely empty run", () => {
    // Distinct from the null cases above: an empty geo box really did rank 0
    // venues, and that is the single most important row to see in the funnel.
    expect(parsePoolSizes({ candidates: [], poolSizes: { curatedInBox: 0, curatedEligible: 0, placesAdded: 0, ranked: 0 } }))
      .toEqual({ curatedInBox: 0, curatedEligible: 0, placesAdded: 0, ranked: 0 });
  });
});

describe("normalizeFailureReason", () => {
  it("groups a relaxation reason by its actionable head", () => {
    // The raw value carries the per-pair sides suffix, which would explode the
    // grouping into one bucket per pair.
    expect(normalizeFailureReason("no_candidates:setting:both")).toBe("no_candidates:setting");
    expect(normalizeFailureReason("no_candidates:setting:A")).toBe("no_candidates:setting");
  });

  it("leaves a plain reason alone", () => {
    expect(normalizeFailureReason("provider_unavailable")).toBe("provider_unavailable");
  });
});

describe("computeVenueConcentration", () => {
  it("computes shares over successful assignments only", () => {
    const rows = [
      row({ selectedPlaceId: "a" }),
      row({ selectedPlaceId: "a" }),
      row({ selectedPlaceId: "a" }),
      row({ selectedPlaceId: "b" }),
      // A failed run must not sit in the denominator: it assigned nothing, so
      // counting it would understate how concentrated the real dates are.
      row({ selectedPlaceId: null, failureReason: "no_candidates:setting:both" }),
    ];
    const [city] = computeVenueConcentration(rows);
    expect(city!.assignments).toBe(4);
    expect(city!.failures).toBe(1);
    expect(city!.uniqueVenues).toBe(2);
    expect(city!.topVenues[0]).toEqual({ placeId: "a", count: 3, share: 0.75 });
    expect(city!.failureReasons).toEqual({ "no_candidates:setting": 1 });
  });

  it("indexes a monopoly at 1 and an even split at 1/n", () => {
    const monopoly = computeVenueConcentration([row({ selectedPlaceId: "a" }), row({ selectedPlaceId: "a" })]);
    expect(monopoly[0]!.concentrationIndex).toBeCloseTo(1);

    const even = computeVenueConcentration([
      row({ selectedPlaceId: "a" }),
      row({ selectedPlaceId: "b" }),
      row({ selectedPlaceId: "c" }),
      row({ selectedPlaceId: "d" }),
    ]);
    expect(even[0]!.concentrationIndex).toBeCloseTo(0.25);
  });

  it("splits by city, orders by volume, and breaks ties alphabetically", () => {
    const rows = [
      row({ cityKey: "ua:kyiv", selectedPlaceId: "a" }),
      row({ cityKey: "ua:kyiv", selectedPlaceId: "b" }),
      row({ cityKey: "ua:lviv", selectedPlaceId: "c" }),
      // A null city is its own bucket rather than being dropped: a run with no
      // `homeCityKey` still consumed a venue and still belongs in the totals.
      row({ cityKey: null, selectedPlaceId: "d" }),
    ];
    const cities = computeVenueConcentration(rows);
    // Kyiv leads on volume (2); lviv and unknown both have 1, so the stable
    // alphabetical tie-break decides — the order must not depend on input order.
    expect(cities.map((c) => c.cityKey)).toEqual(["ua:kyiv", "ua:lviv", UNKNOWN_CITY_KEY]);
  });

  it("excludes funnel-less rows from the funnel stats without zeroing them", () => {
    const rows = [
      row({ poolSizes: { curatedInBox: 100, curatedEligible: 60, placesAdded: 0, ranked: 60 } }),
      row({ poolSizes: { curatedInBox: 200, curatedEligible: 80, placesAdded: 0, ranked: 80 } }),
      row({ poolSizes: null }),
    ];
    const [city] = computeVenueConcentration(rows);
    expect(city!.funnel.ranked.samples).toBe(2);
    expect(city!.funnel.ranked.median).toBe(60);
    expect(city!.funnel.curatedInBox.p90).toBe(200);
  });

  it("reports a zeroed funnel with 0 samples when nothing carried one", () => {
    const [city] = computeVenueConcentration([row()]);
    expect(city!.funnel.ranked).toEqual({ median: 0, p90: 0, samples: 0 });
  });

  it("handles a window with only failures without dividing by zero", () => {
    const [city] = computeVenueConcentration([
      row({ selectedPlaceId: null, failureReason: "provider_unavailable" }),
    ]);
    expect(city!.assignments).toBe(0);
    expect(city!.concentrationIndex).toBe(0);
    expect(city!.topVenues).toEqual([]);
  });

  it("returns nothing for an empty window", () => {
    expect(computeVenueConcentration([])).toEqual([]);
  });
});
