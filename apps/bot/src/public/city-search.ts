import { buildHomeCityKey, type HomeLocationInput } from "./home-location.js";

const PLACES_TIMEOUT_MS = 10_000;

/**
 * City lookup shared by the Telegram onboarding Mini App and the website's
 * pre-registration form (the student track picks its dating city on the web).
 *
 * Google Places is the source when `PLACES_API_KEY` is set; without it — and
 * on any Places failure — the search degrades to the small first-party city
 * list below rather than dead-ending the user.
 */
export interface CitySearchHit extends HomeLocationInput {
  label: string;
}

interface PlacesTextPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  types?: string[];
  location?: { latitude?: number; longitude?: number };
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
}

const FALLBACK_CITIES: CitySearchHit[] = [
  cityHit("Kyiv", "UA", 50.4501, 30.5234, "fallback:ua:kyiv"),
  cityHit("Kharkiv", "UA", 49.9935, 36.2304, "fallback:ua:kharkiv"),
  cityHit("Odesa", "UA", 46.4846, 30.7233, "fallback:ua:odesa"),
  cityHit("Lviv", "UA", 49.8397, 24.0297, "fallback:ua:lviv"),
  cityHit("Warsaw", "PL", 52.2297, 21.0122, "fallback:pl:warsaw"),
  cityHit("Berlin", "DE", 52.52, 13.405, "fallback:de:berlin"),
];

function cityHit(
  city: string,
  countryCode: string,
  latitude: number,
  longitude: number,
  placeId: string | null,
): CitySearchHit {
  return {
    label: `${city}, ${countryCode}`,
    homeCity: city,
    homeCountryCode: countryCode,
    homeCityKey: buildHomeCityKey(city, countryCode),
    homePlaceId: placeId,
    latitude,
    longitude,
  };
}

export async function searchCities(query: string): Promise<CitySearchHit[]> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) return fallbackCitySearch(query);

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.types",
      },
      body: JSON.stringify({
        textQuery: query,
        includedType: "locality",
        maxResultCount: 8,
      }),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
    if (!response.ok) return fallbackCitySearch(query);
    const json = (await response.json()) as { places?: PlacesTextPlace[] };
    const hits = (json.places ?? [])
      .map(cityHitFromPlace)
      .filter((hit): hit is CitySearchHit => hit !== null);
    return hits.length ? hits : fallbackCitySearch(query);
  } catch {
    return fallbackCitySearch(query);
  }
}

function fallbackCitySearch(query: string): CitySearchHit[] {
  const lower = query.toLowerCase();
  return FALLBACK_CITIES.filter((city) => city.homeCity.toLowerCase().includes(lower)).slice(0, 8);
}

function cityHitFromPlace(place: PlacesTextPlace): CitySearchHit | null {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (lat == null || lng == null) return null;

  const city =
    component(place, "locality", "longText") ??
    component(place, "administrative_area_level_1", "longText") ??
    place.displayName?.text ??
    "";
  const countryCode = component(place, "country", "shortText");
  if (!city || !countryCode) return null;
  return {
    ...cityHit(city, countryCode.toUpperCase(), lat, lng, place.id ?? null),
    label: place.formattedAddress ?? `${city}, ${countryCode.toUpperCase()}`,
  };
}

function component(
  place: PlacesTextPlace,
  type: string,
  field: "longText" | "shortText",
): string | null {
  for (const item of place.addressComponents ?? []) {
    if (item.types?.includes(type) && item[field]) return item[field]!;
  }
  return null;
}

interface GeocodeResult {
  place_id?: string;
  types?: string[];
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  address_components?: Array<{
    long_name?: string;
    short_name?: string;
    types?: string[];
  }>;
}

export async function resolveCityFromCoordinates(lat: number, lng: number): Promise<CitySearchHit> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) return FALLBACK_CITIES[0]!;

  try {
    const params = new URLSearchParams({
      latlng: `${lat},${lng}`,
      key: apiKey,
      result_type: "locality|administrative_area_level_1",
    });
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
      { signal: AbortSignal.timeout(PLACES_TIMEOUT_MS) },
    );
    if (!response.ok) return FALLBACK_CITIES[0]!;
    const json = (await response.json()) as { results?: GeocodeResult[] };
    for (const result of json.results ?? []) {
      const hit = cityHitFromGeocode(result);
      if (hit) return hit;
    }
    return FALLBACK_CITIES[0]!;
  } catch {
    return FALLBACK_CITIES[0]!;
  }
}

function cityHitFromGeocode(result: GeocodeResult): CitySearchHit | null {
  const city =
    geocodeComponent(result, "locality", "long_name") ??
    geocodeComponent(result, "administrative_area_level_1", "long_name") ??
    "";
  const countryCode = geocodeComponent(result, "country", "short_name");
  const lat = result.geometry?.location?.lat;
  const lng = result.geometry?.location?.lng;
  if (!city || !countryCode || lat == null || lng == null) return null;
  return {
    ...cityHit(city, countryCode.toUpperCase(), lat, lng, result.place_id ?? null),
    label: result.formatted_address ?? `${city}, ${countryCode.toUpperCase()}`,
  };
}

function geocodeComponent(
  result: GeocodeResult,
  type: string,
  field: "long_name" | "short_name",
): string | null {
  for (const item of result.address_components ?? []) {
    if (item.types?.includes(type) && item[field]) return item[field]!;
  }
  return null;
}
