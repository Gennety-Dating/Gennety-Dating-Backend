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

  it("accepts a point well inside the commuter belt", () => {
    // ~35 km north of the centroid — Kyiv's radius is 60 km, so a real suburb
    // must pass. This is the case the generous radius exists for.
    expect(checkDepartureOrigin(KYIV, KYIV.latitude + 0.32, KYIV.longitude).ok).toBe(true);
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
