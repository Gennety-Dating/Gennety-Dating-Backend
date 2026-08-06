import { prisma } from "@gennety/db";
import { distanceKm, findMarketByCityKey, type Market } from "@gennety/shared";

/**
 * The departure-point gate (PRODUCT_SPEC §3.7).
 *
 * The venue step asks each side where they'll be setting off from, and until
 * this module existed the only validation was that the coordinates were
 * numbers — so a user could mark a point in another city or another country.
 * That is the exact hole `validateHomeLocationPayload` (`public/home-location.ts`)
 * closes for the REGISTRATION city, and for the same reason: matching is
 * strictly same-city, and the concierge looks for a venue within a few km of
 * BOTH origins, so a pin outside the launched market cannot produce a single
 * candidate. Allowing it does not give the user a date in Berlin — it gives
 * them a dead end an hour later, on a screen with nothing left to fix.
 *
 * One validator, four call sites (the Location Mini App save, the V2
 * interpret/confirm pair shared by Telegram and iOS, and the raw Telegram
 * location pin), so no client can route around it.
 *
 * The radius comes from the market's own `radiusKm` — 60 km for Kyiv, i.e. the
 * whole commuter belt. `markets.ts` documents that value as the "are you inside
 * this market?" answer for onboarding geolocation, where a false negative is
 * cheap; here it is a hard gate, which is why the generous figure matters: it
 * must never refuse someone who genuinely lives in the metro area.
 */

export type DepartureOriginCheck =
  | { ok: true }
  | { ok: false; reason: "outside-market"; market: Market; distanceKm: number };

/**
 * The market as both clients receive it: enough to centre the map, draw the
 * zone, gate Confirm live, and name the city in the refusal copy. Sent rather
 * than compiled into the bundle for the same reason `/state.profileLimits` is
 * (PRODUCT_SPEC §1.3) — a bound in two places eventually disagrees with itself,
 * and a second launched market must not need a Mini App redeploy.
 */
export interface MarketView {
  cityKey: string;
  city: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export function marketView(market: Market): MarketView {
  return {
    cityKey: market.cityKey,
    city: market.city,
    latitude: market.latitude,
    longitude: market.longitude,
    radiusKm: market.radiusKm,
  };
}

/**
 * The refusal both `/v1/*` surfaces return for an out-of-market pin. Carried as
 * a value rather than a thrown error because the two callers already branch on
 * a `null` return, and a bare `null` here would be reported as "match not in
 * venue negotiation" — a lie about why the write was refused.
 */
export interface VenueOriginRefusal {
  error: "origin-outside-market";
  market: MarketView;
}

export function venueOriginRefusal(market: Market): VenueOriginRefusal {
  return { error: "origin-outside-market", market: marketView(market) };
}

export function isVenueOriginRefusal(value: unknown): value is VenueOriginRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "origin-outside-market"
  );
}

/**
 * The launched market a user's dates belong to, or `null` when we cannot say.
 *
 * `null` means "do not gate", never "refuse": an account with no dating city,
 * or one registered before the launched-market gate (PRODUCT_SPEC §1.3), is a
 * gap in OUR data, and a user must not be blocked over it. Such an account
 * cannot hold a match anyway — the engine joins on an exact `homeCityKey`
 * equality (§3.2 filter 5) — so the permissive branch is unreachable in
 * practice and exists purely so a data gap can never strand someone.
 */
export async function resolveDepartureMarket(userId: string): Promise<Market | null> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { homeCityKey: true },
  });
  return findMarketByCityKey(profile?.homeCityKey ?? null);
}

/** Pure geometry: is this pin inside the user's market? */
export function checkDepartureOrigin(
  market: Market | null,
  lat: number,
  lng: number,
): DepartureOriginCheck {
  if (!market) return { ok: true };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: true };
  const distance = distanceKm(lat, lng, market.latitude, market.longitude);
  if (distance <= market.radiusKm) return { ok: true };
  return { ok: false, reason: "outside-market", market, distanceKm: distance };
}

/** `resolveDepartureMarket` + `checkDepartureOrigin` — the usual call shape. */
export async function assertDepartureOrigin(
  userId: string,
  lat: number,
  lng: number,
): Promise<DepartureOriginCheck> {
  return checkDepartureOrigin(await resolveDepartureMarket(userId), lat, lng);
}
