import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { haversineDistanceKm, type LatLng } from "../../services/geo.js";
import { getOrCompute } from "../utils/cache.js";

// ---------------------------------------------------------------------------
// GET /admin/analytics/cities
// ---------------------------------------------------------------------------
// Male/female distribution per city. Per-user city attribution follows two
// rules (PRODUCT decision):
//   1. Users who have been on a date are placed by the *departure point* they
//      marked heading out (`Match.vibeLat/Lng{A,B}`), snapped to the nearest
//      known city centroid.
//   2. Everyone else is placed by their *matching city* (`Profile.homeCityKey`).
// City centroids are derived from the user base itself (one per `homeCityKey`),
// so no external geocoder / schema change is needed — matching is already
// city-scoped, so departure pins fall inside cities we already know.
// ---------------------------------------------------------------------------

const UNKNOWN_CITY_KEY = "unknown";

export interface CityUserInput {
  id: string;
  gender: string | null;
  homeCityKey: string | null;
  homeCity: string | null;
  homeCountryCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface DeparturePin {
  lat: number;
  lng: number;
}

export interface CityRow {
  cityKey: string;
  city: string;
  countryCode: string | null;
  total: number;
  male: number;
  female: number;
  unknown: number;
  /** How many of this city's users were placed by their departure pin. */
  fromDeparture: number;
}

export interface CityDistribution {
  totalUsers: number;
  attribution: { byDeparture: number; byMatchingCity: number; unknown: number };
  cities: CityRow[];
}

interface CityRegistryEntry {
  cityKey: string;
  countryCode: string | null;
  /** Vote for the display name (users may spell/case a city differently). */
  nameVotes: Map<string, number>;
  latSum: number;
  lngSum: number;
  coordCount: number;
}

interface Aggregate {
  male: number;
  female: number;
  unknown: number;
  fromDeparture: number;
}

/**
 * Pure attribution + aggregation. Kept side-effect free (no prisma, no express)
 * so it can be unit-tested directly with plain fixtures.
 */
export function computeCityDistribution(
  users: CityUserInput[],
  pins: Map<string, DeparturePin>,
): CityDistribution {
  // 1. Build a city registry keyed by homeCityKey — display name + centroid.
  const registry = new Map<string, CityRegistryEntry>();
  const registryFor = (key: string): CityRegistryEntry => {
    let entry = registry.get(key);
    if (!entry) {
      entry = {
        cityKey: key,
        countryCode: null,
        nameVotes: new Map(),
        latSum: 0,
        lngSum: 0,
        coordCount: 0,
      };
      registry.set(key, entry);
    }
    return entry;
  };

  for (const u of users) {
    if (!u.homeCityKey) continue;
    const entry = registryFor(u.homeCityKey);
    if (u.homeCountryCode && !entry.countryCode) {
      entry.countryCode = u.homeCountryCode.toUpperCase();
    }
    const name = (u.homeCity ?? "").trim();
    if (name) entry.nameVotes.set(name, (entry.nameVotes.get(name) ?? 0) + 1);
    if (
      u.latitude !== null &&
      u.longitude !== null &&
      Number.isFinite(u.latitude) &&
      Number.isFinite(u.longitude)
    ) {
      entry.latSum += u.latitude;
      entry.lngSum += u.longitude;
      entry.coordCount++;
    }
  }

  // Snap targets: only cities with at least one member coordinate.
  const centroids: Array<{ cityKey: string; point: LatLng }> = [];
  for (const entry of registry.values()) {
    if (entry.coordCount > 0) {
      centroids.push({
        cityKey: entry.cityKey,
        point: { lat: entry.latSum / entry.coordCount, lng: entry.lngSum / entry.coordCount },
      });
    }
  }

  const nearestCityKey = (pin: DeparturePin): string | null => {
    let bestKey: string | null = null;
    let bestDist = Infinity;
    const p: LatLng = { lat: pin.lat, lng: pin.lng };
    for (const c of centroids) {
      const d = haversineDistanceKm(p, c.point);
      if (d < bestDist) {
        bestDist = d;
        bestKey = c.cityKey;
      }
    }
    return bestKey;
  };

  const displayName = (key: string): string => {
    const entry = registry.get(key);
    if (!entry) return key;
    let best = "";
    let bestVotes = -1;
    for (const [name, votes] of entry.nameVotes) {
      if (votes > bestVotes) {
        best = name;
        bestVotes = votes;
      }
    }
    return best || key;
  };

  // 2. Attribute + aggregate.
  const buckets = new Map<string, Aggregate>();
  const bucketFor = (key: string): Aggregate => {
    let b = buckets.get(key);
    if (!b) {
      b = { male: 0, female: 0, unknown: 0, fromDeparture: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  let byDeparture = 0;
  let byMatchingCity = 0;
  let unknownAttr = 0;

  for (const u of users) {
    const pin = pins.get(u.id);
    let cityKey: string;
    let viaDeparture = false;

    const snapped = pin ? nearestCityKey(pin) : null;
    if (snapped) {
      cityKey = snapped;
      viaDeparture = true;
    } else if (u.homeCityKey) {
      cityKey = u.homeCityKey;
    } else {
      cityKey = UNKNOWN_CITY_KEY;
    }

    const bucket = bucketFor(cityKey);
    if (u.gender === "male") bucket.male++;
    else if (u.gender === "female") bucket.female++;
    else bucket.unknown++;

    if (viaDeparture) {
      bucket.fromDeparture++;
      byDeparture++;
    } else if (cityKey === UNKNOWN_CITY_KEY) {
      unknownAttr++;
    } else {
      byMatchingCity++;
    }
  }

  const cities: CityRow[] = Array.from(buckets.entries())
    .map(([cityKey, b]) => ({
      cityKey,
      city: cityKey === UNKNOWN_CITY_KEY ? "Unknown" : displayName(cityKey),
      countryCode: cityKey === UNKNOWN_CITY_KEY ? null : (registry.get(cityKey)?.countryCode ?? null),
      total: b.male + b.female + b.unknown,
      male: b.male,
      female: b.female,
      unknown: b.unknown,
      fromDeparture: b.fromDeparture,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    totalUsers: users.length,
    attribution: { byDeparture, byMatchingCity, unknown: unknownAttr },
    cities,
  };
}

export const citiesRouter: Router = Router();

citiesRouter.get(
  "/admin/analytics/cities",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("cities:v1", 600, async () => {
        const [users, pinRows] = await Promise.all([
          prisma.user.findMany({
            select: {
              id: true,
              gender: true,
              profile: {
                select: {
                  homeCityKey: true,
                  homeCity: true,
                  homeCountryCode: true,
                  latitude: true,
                  longitude: true,
                },
              },
            },
          }),
          // Any match with a departure pin on either side. Ascending order so
          // the last write per user in the loop below is their newest pin.
          prisma.match.findMany({
            where: {
              OR: [{ vibeLatA: { not: null } }, { vibeLatB: { not: null } }],
            },
            select: {
              userAId: true,
              userBId: true,
              vibeLatA: true,
              vibeLngA: true,
              vibeLatB: true,
              vibeLngB: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: "asc" },
          }),
        ]);

        const pins = new Map<string, DeparturePin>();
        for (const m of pinRows) {
          if (m.vibeLatA !== null && m.vibeLngA !== null) {
            pins.set(m.userAId, { lat: m.vibeLatA, lng: m.vibeLngA });
          }
          if (m.vibeLatB !== null && m.vibeLngB !== null) {
            pins.set(m.userBId, { lat: m.vibeLatB, lng: m.vibeLngB });
          }
        }

        const userInputs: CityUserInput[] = users.map((u) => ({
          id: u.id,
          gender: u.gender,
          homeCityKey: u.profile?.homeCityKey ?? null,
          homeCity: u.profile?.homeCity ?? null,
          homeCountryCode: u.profile?.homeCountryCode ?? null,
          latitude: u.profile?.latitude ?? null,
          longitude: u.profile?.longitude ?? null,
        }));

        return computeCityDistribution(userInputs, pins);
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] cities error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
