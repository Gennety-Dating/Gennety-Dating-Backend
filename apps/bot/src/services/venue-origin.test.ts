/**
 * The departure-point gate. `checkDepartureOrigin` is pure geometry and is
 * exercised directly; `resolveDepartureMarket` is covered through a mocked
 * Prisma so neither the DB nor a real profile is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MARKET, findMarketByCityKey } from "@gennety/shared";

const findUniqueMock = vi.hoisted(() => vi.fn());

vi.mock("@gennety/db", () => ({
  prisma: { profile: { findUnique: findUniqueMock } },
}));

const { checkDepartureOrigin, resolveDepartureMarket, assertDepartureOrigin } = await import(
  "./venue-origin.js"
);

const KYIV = DEFAULT_MARKET;

beforeEach(() => {
  findUniqueMock.mockReset();
});

describe("checkDepartureOrigin", () => {
  it("accepts the market centroid", () => {
    expect(checkDepartureOrigin(KYIV, KYIV.latitude, KYIV.longitude)).toEqual({ ok: true });
  });

  it("accepts a point at the city's own edge", () => {
    // Bortnychi, ~17 km south-east — a real Kyiv district, comfortably inside.
    expect(checkDepartureOrigin(KYIV, 50.38, 30.73).ok).toBe(true);
    // Koncha-Zaspa, ~20 km south. This is the southern extremity of Kyiv and
    // the reason the radius is 21 km rather than 18: the city is longer than
    // the near suburbs are far, so trimming to exclude Brovary would cut real
    // districts. See `markets.ts`.
    expect(checkDepartureOrigin(KYIV, 50.27, 30.55).ok).toBe(true);
  });

  it("refuses a separate city in the same oblast", () => {
    // Boryspil, ~33 km out. It passed under the old 60 km commuter-belt radius,
    // which is what the 2026-08-18 narrowing was for: ads target Kyiv proper,
    // so an oblast departure point is someone we cannot serve.
    const result = checkDepartureOrigin(KYIV, 50.35, 30.955);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.distanceKm).toBeGreaterThan(KYIV.radiusKm);
  });

  it("refuses another country and reports the distance", () => {
    // Berlin Hauptbahnhof — the exact pin that used to be saved silently.
    const result = checkDepartureOrigin(KYIV, 52.525, 13.369);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("outside-market");
    expect(result.market.cityKey).toBe("ua:kyiv");
    expect(result.distanceKm).toBeGreaterThan(1000);
  });

  it("refuses another Ukrainian city outside the market", () => {
    // Lviv — same country, still not a launched market.
    expect(checkDepartureOrigin(KYIV, 49.8397, 24.0297).ok).toBe(false);
  });

  it("is permissive when the market is unknown", () => {
    // A legacy account whose city was never a launched market. Blocking a user
    // over a gap in our own data is never the right answer.
    expect(checkDepartureOrigin(null, 52.525, 13.369)).toEqual({ ok: true });
  });

  it("is permissive on non-finite coordinates", () => {
    // Range/shape validation belongs to the callers; this gate only answers
    // the market question, and must not double as a second coordinate check
    // that reports the wrong reason.
    expect(checkDepartureOrigin(KYIV, Number.NaN, 30.5)).toEqual({ ok: true });
  });
});

describe("resolveDepartureMarket", () => {
  it("resolves the market from the profile's dating city", async () => {
    findUniqueMock.mockResolvedValue({ homeCityKey: "ua:kyiv" });
    await expect(resolveDepartureMarket("u1")).resolves.toEqual(findMarketByCityKey("ua:kyiv"));
  });

  it("returns null for an unlaunched city", async () => {
    findUniqueMock.mockResolvedValue({ homeCityKey: "de:berlin" });
    await expect(resolveDepartureMarket("u1")).resolves.toBeNull();
  });

  it("returns null when there is no profile at all", async () => {
    findUniqueMock.mockResolvedValue(null);
    await expect(resolveDepartureMarket("u1")).resolves.toBeNull();
  });
});

describe("assertDepartureOrigin", () => {
  it("refuses an out-of-market pin for a Kyiv account", async () => {
    findUniqueMock.mockResolvedValue({ homeCityKey: "ua:kyiv" });
    const result = await assertDepartureOrigin("u1", 52.525, 13.369);
    expect(result.ok).toBe(false);
  });

  it("lets an unresolvable account through", async () => {
    findUniqueMock.mockResolvedValue({ homeCityKey: null });
    await expect(assertDepartureOrigin("u1", 52.525, 13.369)).resolves.toEqual({ ok: true });
  });
});
