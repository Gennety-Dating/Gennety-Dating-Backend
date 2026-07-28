import {
  SUPPORTED_MARKETS,
  marketForCoordinates,
  searchMarkets,
  type Market,
} from "@gennety/shared";
import type { HomeLocationInput } from "./home-location.js";

/**
 * City lookup for the onboarding "dating city" step.
 *
 * First-party by design (2026-07-28): the picker only ever offers a **launched
 * market** (`packages/shared/src/markets.ts`). It used to query Google Places,
 * which could only ever propose cities the server must then refuse — matching
 * is strictly same-city, so registering elsewhere creates an isolated pool of
 * one. Dropping the provider also removes a real bug: without `PLACES_API_KEY`
 * the reverse-geocode silently resolved ANY coordinates to the first fallback
 * city (Kyiv). `PLACES_API_KEY` is still required for venues — only the city
 * lookup stopped using it.
 */
export interface CitySearchHit extends HomeLocationInput {
  label: string;
}

export function cityHitForMarket(market: Market): CitySearchHit {
  return {
    label: `${market.city}, ${market.countryCode}`,
    homeCity: market.city,
    homeCountryCode: market.countryCode,
    homeCityKey: market.cityKey,
    homePlaceId: null,
    latitude: market.latitude,
    longitude: market.longitude,
  };
}

/** Every launched market, in display order — the picker's default list. */
export function supportedCityHits(): CitySearchHit[] {
  return SUPPORTED_MARKETS.map(cityHitForMarket);
}

/** Manual search. Never returns a city we have not launched. */
export function searchCities(query: string): CitySearchHit[] {
  return searchMarkets(query).map(cityHitForMarket);
}

export interface CityResolution {
  /** True when the coordinates fall inside a launched market. */
  supported: boolean;
  /** The market to select; `null` when the user is outside every market. */
  city: CitySearchHit | null;
}

/**
 * Resolve a geolocation fix into a launched market. Deliberately geometric
 * rather than a geocode: the only question the onboarding step asks is "are you
 * in a city we operate in", and an unresolvable answer must be `null` — never a
 * market the person is not actually in.
 */
export function resolveMarketFromCoordinates(lat: number, lng: number): CityResolution {
  const market = marketForCoordinates(lat, lng);
  if (!market) return { supported: false, city: null };
  return { supported: true, city: cityHitForMarket(market) };
}
