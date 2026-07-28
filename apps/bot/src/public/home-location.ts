import { prisma, type Profile } from "@gennety/db";
import { cityKeyToTimeZone, findMarketByCityKey, type Market } from "@gennety/shared";

const MAX_CITY_LENGTH = 120;
const MAX_COUNTRY_CODE_LENGTH = 8;
const MAX_CITY_KEY_LENGTH = 160;
const MAX_PLACE_ID_LENGTH = 256;

export interface HomeLocationInput {
  homeCity: string;
  homeCountryCode: string;
  homeCityKey: string;
  homePlaceId: string | null;
  latitude: number;
  longitude: number;
}

export type HomeLocationValidation =
  | { ok: true; data: HomeLocationInput }
  | { ok: false; error: string };

export function slugCity(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (ascii) return ascii;
  return Array.from(value.trim().toLowerCase())
    .map((char) => char.codePointAt(0)?.toString(36) ?? "")
    .filter(Boolean)
    .join("-")
    .slice(0, 96);
}

export function buildHomeCityKey(city: string, countryCode: string): string {
  const country = countryCode.trim().toLowerCase();
  const citySlug = slugCity(city);
  return citySlug ? `${country}:${citySlug}` : country;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

export function validateHomeLocationPayload(
  body: Record<string, unknown>,
): HomeLocationValidation {
  const homeCity = stringField(body, "homeCity");
  const homeCountryCode = stringField(body, "homeCountryCode").toUpperCase();
  const providedCityKey = stringField(body, "homeCityKey");
  const providedPlaceId = stringField(body, "homePlaceId");
  const latitude = body.latitude;
  const longitude = body.longitude;

  if (!homeCity || homeCity.length > MAX_CITY_LENGTH) {
    return { ok: false, error: "Invalid homeCity" };
  }
  if (
    !homeCountryCode ||
    homeCountryCode.length > MAX_COUNTRY_CODE_LENGTH ||
    !/^[A-Z]{2,8}$/.test(homeCountryCode)
  ) {
    return { ok: false, error: "Invalid homeCountryCode" };
  }
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    return { ok: false, error: "Invalid latitude" };
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { ok: false, error: "Invalid longitude" };
  }

  const homeCityKey = providedCityKey || buildHomeCityKey(homeCity, homeCountryCode);
  if (
    !homeCityKey ||
    homeCityKey.length > MAX_CITY_KEY_LENGTH ||
    !/^[a-z0-9][a-z0-9:_-]*[a-z0-9]$/.test(homeCityKey)
  ) {
    return { ok: false, error: "Invalid homeCityKey" };
  }
  if (providedPlaceId && providedPlaceId.length > MAX_PLACE_ID_LENGTH) {
    return { ok: false, error: "Invalid homePlaceId" };
  }

  // The market gate. Matching is strictly same-city, so a city we have not
  // launched is a pool of one — refuse it here rather than let the user
  // register into a dead end. This is the ONLY writer of `homeCityKey`, so the
  // single check covers Telegram (`/city/select`) and iOS (`/me/home-location`)
  // alike.
  const market = findMarketByCityKey(homeCityKey);
  if (!market) return { ok: false, error: "city-not-supported" };

  return { ok: true, data: homeLocationForMarket(market, providedPlaceId || null) };
}

/**
 * Canonical payload for a launched market. The client's city name and
 * coordinates are replaced by the market's own — they only ever identify WHICH
 * market was picked, and a drifting/spoofed centroid would land in
 * `Profile.latitude/longitude`, which the venue picker and city analytics read.
 */
export function homeLocationForMarket(
  market: Market,
  homePlaceId: string | null = null,
): HomeLocationInput {
  return {
    homeCity: market.city,
    homeCountryCode: market.countryCode,
    homeCityKey: market.cityKey,
    homePlaceId,
    latitude: market.latitude,
    longitude: market.longitude,
  };
}

export async function saveHomeLocationForUser(
  userId: string,
  input: HomeLocationInput,
): Promise<Profile> {
  const now = new Date();
  // Derive the IANA timezone for the Profiler's local-time batch windows
  // (PRODUCT_SPEC §Phase 1b). Falls back to Europe/Kyiv when unknown.
  const timeZone = cityKeyToTimeZone(input.homeCityKey, input.homeCountryCode);
  return prisma.profile.upsert({
    where: { userId },
    update: {
      homeCity: input.homeCity,
      homeCountryCode: input.homeCountryCode,
      homeCityKey: input.homeCityKey,
      homePlaceId: input.homePlaceId,
      latitude: input.latitude,
      longitude: input.longitude,
      locationUpdatedAt: now,
      timeZone,
    },
    create: {
      userId,
      homeCity: input.homeCity,
      homeCountryCode: input.homeCountryCode,
      homeCityKey: input.homeCityKey,
      homePlaceId: input.homePlaceId,
      latitude: input.latitude,
      longitude: input.longitude,
      locationUpdatedAt: now,
      timeZone,
    },
  });
}
