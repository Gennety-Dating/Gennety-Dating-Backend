import { describe, it, expect } from "vitest";
import {
  midpoint,
  haversineDistanceKm,
  venueSearchRadiusMeters,
} from "./geo.js";

describe("geo: midpoint", () => {
  it("returns the input point when both coordinates are identical", () => {
    const p = { lat: 37.4275, lng: -122.1697 }; // Stanford
    const m = midpoint(p, p);
    expect(m.lat).toBe(p.lat);
    expect(m.lng).toBe(p.lng);
  });

  it("is symmetric: midpoint(a,b) == midpoint(b,a)", () => {
    const a = { lat: 37.4275, lng: -122.1697 };
    const b = { lat: 42.3601, lng: -71.0589 };
    const mAB = midpoint(a, b);
    const mBA = midpoint(b, a);
    expect(mAB.lat).toBeCloseTo(mBA.lat, 10);
    expect(mAB.lng).toBeCloseTo(mBA.lng, 10);
  });

  it("computes the great-circle midpoint between Stanford and MIT", () => {
    // Stanford: 37.4275, -122.1697
    // MIT:     42.3601,  -71.0589
    // True great-circle midpoint is NOT the naive average — it curves north.
    const mid = midpoint(
      { lat: 37.4275, lng: -122.1697 },
      { lat: 42.3601, lng: -71.0589 },
    );
    // Midpoint lat is higher than the naive average of 39.8938 because the
    // great circle arcs poleward across North America.
    expect(mid.lat).toBeGreaterThan(39.8938);
    expect(mid.lat).toBeLessThan(45);
    // Longitude sits in the middle of the continent (Great Plains region).
    expect(mid.lng).toBeGreaterThan(-100);
    expect(mid.lng).toBeLessThan(-95);
  });

  it("handles the antimeridian correctly (does NOT drift to lng=0)", () => {
    // Two points straddling 180°: the naive average would yield ~0°, which
    // is the wrong side of the planet. The great-circle midpoint should
    // stay in the Pacific (|lng| > 170).
    const a = { lat: 0, lng: 179 };
    const b = { lat: 0, lng: -179 };
    const m = midpoint(a, b);
    expect(Math.abs(m.lat)).toBeLessThan(0.001);
    expect(Math.abs(m.lng)).toBeGreaterThan(179.5);
  });

  it("midpoint of two nearby points lies strictly between them", () => {
    const a = { lat: 37.4275, lng: -122.1697 };
    const b = { lat: 37.8719, lng: -122.2585 }; // UC Berkeley
    const m = midpoint(a, b);
    expect(m.lat).toBeGreaterThan(Math.min(a.lat, b.lat));
    expect(m.lat).toBeLessThan(Math.max(a.lat, b.lat));
    expect(m.lng).toBeGreaterThan(Math.min(a.lng, b.lng));
    expect(m.lng).toBeLessThan(Math.max(a.lng, b.lng));
  });
});

describe("geo: haversineDistanceKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });

  it("computes Stanford→MIT distance within ~1% of the known great-circle value (~4329 km)", () => {
    const d = haversineDistanceKm(
      { lat: 37.4275, lng: -122.1697 },
      { lat: 42.3601, lng: -71.0589 },
    );
    // Known: ~4329 km. Allow ±1% band.
    expect(d).toBeGreaterThan(4285);
    expect(d).toBeLessThan(4372);
  });

  it("is symmetric", () => {
    const a = { lat: 51.505, lng: -0.09 };
    const b = { lat: 48.8566, lng: 2.3522 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 6);
  });
});

describe("geo: venueSearchRadiusMeters", () => {
  it("floors at 500m for very close pairs", () => {
    expect(venueSearchRadiusMeters(0)).toBe(500);
    expect(venueSearchRadiusMeters(1)).toBe(500); // 300m → clamped to 500
  });

  it("caps at 5000m even for city-scale pairs", () => {
    expect(venueSearchRadiusMeters(100)).toBe(5000);
  });

  it("scales roughly with 30% of the spread in the middle band", () => {
    // 10 km spread → 3000m search radius (well under the cap).
    expect(venueSearchRadiusMeters(10)).toBe(3000);
  });
});
