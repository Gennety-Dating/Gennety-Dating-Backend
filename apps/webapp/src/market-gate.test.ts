import { describe, expect, it } from "vitest";
import { distanceKm, isInsideMarket, type MarketBounds } from "./market-gate.js";

const KYIV: MarketBounds = {
  cityKey: "ua:kyiv",
  city: "Kyiv",
  latitude: 50.4501,
  longitude: 30.5234,
  radiusKm: 60,
};

describe("distanceKm", () => {
  it("is zero at the same point", () => {
    expect(distanceKm(50.45, 30.52, 50.45, 30.52)).toBe(0);
  });

  it("matches the server's Kyiv→Berlin distance to within a kilometre", () => {
    // The client and server run separate copies of this haversine (the webapp
    // deliberately does not depend on `@gennety/shared`), so they have to agree
    // — otherwise Confirm stays lit for a pin the server is about to refuse.
    expect(distanceKm(50.4501, 30.5234, 52.525, 13.369)).toBeCloseTo(1206, -1);
  });
});

describe("isInsideMarket", () => {
  it("accepts the city centre", () => {
    expect(isInsideMarket(KYIV, KYIV.latitude, KYIV.longitude)).toBe(true);
  });

  it("accepts a real suburb inside the commuter belt", () => {
    // ~35 km out. The radius is generous by design: this gate must never
    // refuse someone who genuinely lives in the metro area.
    expect(isInsideMarket(KYIV, KYIV.latitude + 0.32, KYIV.longitude)).toBe(true);
  });

  it("refuses another country", () => {
    expect(isInsideMarket(KYIV, 52.525, 13.369)).toBe(false);
  });

  it("refuses another city in the same country", () => {
    // Lviv — the case a country-level check would have missed.
    expect(isInsideMarket(KYIV, 49.8397, 24.0297)).toBe(false);
  });

  it("is permissive before the market is known", () => {
    // `/state` is async and the map is up first; blocking Confirm during that
    // gap would look like the app is broken.
    expect(isInsideMarket(null, 52.525, 13.369)).toBe(true);
  });

  it("is permissive on non-finite coordinates", () => {
    expect(isInsideMarket(KYIV, Number.NaN, 30.52)).toBe(true);
  });
});
