import { describe, it, expect } from "vitest";
import { computeWaitlistDistribution } from "./city-waitlist.js";

function lead(
  cityKey: string,
  city: string,
  countryCode: string,
  gender: string | null,
  joined: string,
) {
  return { cityKey, city, countryCode, gender, createdAt: new Date(joined) };
}

describe("computeWaitlistDistribution", () => {
  it("counts people per city with a gender split, busiest first", () => {
    const result = computeWaitlistDistribution([
      lead("de:berlin", "Berlin", "DE", "female", "2026-09-01T10:00:00.000Z"),
      lead("de:berlin", "Berlin", "DE", "male", "2026-09-03T10:00:00.000Z"),
      lead("de:berlin", "Berlin", "DE", null, "2026-09-02T10:00:00.000Z"),
      lead("ua:lviv", "Lviv", "UA", "male", "2026-09-04T10:00:00.000Z"),
    ]);

    expect(result.totalWaiting).toBe(4);
    expect(result.cities[0]).toMatchObject({
      cityKey: "de:berlin",
      city: "Berlin",
      countryCode: "DE",
      status: "waitlist",
      total: 3,
      male: 1,
      female: 1,
      unknown: 1,
      firstJoinedAt: "2026-09-01T10:00:00.000Z",
      lastJoinedAt: "2026-09-03T10:00:00.000Z",
    });
    expect(result.cities[1]).toMatchObject({ cityKey: "ua:lviv", total: 1 });
  });

  it("keeps an empty waitlist city on the table", () => {
    // "Nobody in Dresden yet" and "Dresden is not on the expansion list" are
    // different answers, and a table that omits empty rows cannot tell them
    // apart — which is exactly the question this view is read to answer.
    const result = computeWaitlistDistribution([]);
    expect(result.totalWaiting).toBe(0);
    const dresden = result.cities.find((c) => c.cityKey === "de:dresden");
    expect(dresden).toMatchObject({ city: "Dresden", total: 0, firstJoinedAt: null });
    expect(result.cities.length).toBeGreaterThan(1);
  });

  it("never lists a launched market as a waitlist city", () => {
    // Kyiv's demand is its user base, not a waiting list; showing a market
    // here would double-count the same person's meaning.
    const result = computeWaitlistDistribution([
      lead("ua:kyiv", "Kyiv", "UA", "female", "2026-09-01T10:00:00.000Z"),
    ]);
    expect(result.cities.some((c) => c.cityKey === "ua:kyiv")).toBe(false);
    // …and a row that should not exist is surfaced, not swallowed.
    expect(result.orphaned).toEqual([{ cityKey: "ua:kyiv", total: 1 }]);
    expect(result.totalWaiting).toBe(1);
  });

  it("surfaces rows whose city left the catalog", () => {
    // The realistic cause is a city launching while people still wait on the
    // old key: a migration to run, not a display bug to hide.
    const result = computeWaitlistDistribution([
      lead("xx:atlantis", "Atlantis", "XX", null, "2026-09-01T10:00:00.000Z"),
      lead("xx:atlantis", "Atlantis", "XX", null, "2026-09-02T10:00:00.000Z"),
    ]);
    expect(result.orphaned).toEqual([{ cityKey: "xx:atlantis", total: 2 }]);
    expect(result.cities.every((c) => c.total === 0)).toBe(true);
  });
});
