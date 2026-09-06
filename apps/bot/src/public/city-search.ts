import {
  CITY_CATALOG,
  cityForCoordinates,
  searchCityCatalog,
  type City,
  type CityStatus,
} from "@gennety/shared";
import type { HomeLocationInput } from "./home-location.js";

/**
 * City lookup for the onboarding "dating city" step.
 *
 * First-party by design (2026-07-28): the picker only ever offers a city from
 * our own catalog (`packages/shared/src/markets.ts`). It used to query Google
 * Places, which could only ever propose cities the server must then refuse —
 * matching is strictly same-city, so registering elsewhere creates an isolated
 * pool of one. Dropping the provider also removes a real bug: without
 * `PLACES_API_KEY` the reverse-geocode silently resolved ANY coordinates to the
 * first fallback city (Kyiv). `PLACES_API_KEY` is still required for venues —
 * only the city lookup stopped using it.
 *
 * Since the waitlist (2026-09-04) the catalog has two tiers and every hit
 * carries its `status`. An `active` hit is a launched market and continues
 * registration; a `waitlist` hit records demand and ends it at the waitlist
 * screen. The hit shape is otherwise identical, so a `waitlist` hit still
 * cannot be saved as a home location by accident —
 * `validateHomeLocationPayload` refuses it exactly as it always has.
 */
export interface CitySearchHit extends HomeLocationInput {
  label: string;
  status: CityStatus;
}

export function cityHitFor(city: City): CitySearchHit {
  return {
    label: `${city.city}, ${city.countryCode}`,
    homeCity: city.city,
    homeCountryCode: city.countryCode,
    homeCityKey: city.cityKey,
    homePlaceId: null,
    latitude: city.latitude,
    longitude: city.longitude,
    status: city.status,
  };
}

/** Every launched market, in display order. */
export function supportedCityHits(): CitySearchHit[] {
  return CITY_CATALOG.filter((city) => city.status === "active").map(cityHitFor);
}

/**
 * The whole catalog — launched markets first, then the expansion list, grouped
 * by country in display order. The picker's default list.
 */
export function cityCatalogHits(): CitySearchHit[] {
  return CITY_CATALOG.map(cityHitFor);
}

/** Manual search. Never returns a city outside our own catalog. */
export function searchCities(query: string): CitySearchHit[] {
  return searchCityCatalog(query).map(cityHitFor);
}

export interface CityResolution {
  /** True when the coordinates fall inside a **launched** market. */
  supported: boolean;
  /**
   * The city to pre-select; `null` when the coordinates are outside every city
   * in the catalog. May be a waitlist city, in which case `supported` is false
   * and the client shows it as the coming-soon option rather than as an error —
   * an older bundle reads `supported: false` first and simply shows its
   * "not launched here" note, which is still true.
   */
  city: CitySearchHit | null;
}

/**
 * Resolve a geolocation fix into a catalog city. Deliberately geometric rather
 * than a geocode: the only question the onboarding step asks is "which of our
 * cities are you in", and an unresolvable answer must be `null` — never a city
 * the person is not actually in.
 */
export function resolveCityFromCoordinates(lat: number, lng: number): CityResolution {
  const city = cityForCoordinates(lat, lng);
  if (!city) return { supported: false, city: null };
  return { supported: city.status === "active", city: cityHitFor(city) };
}
