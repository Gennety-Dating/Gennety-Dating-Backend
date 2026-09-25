#!/usr/bin/env node
/**
 * OpenStreetMap enrichment of `curated_venues` for venue Tier 2 (Tempo Sync,
 * decision journal 2026-09-24).
 *
 * Writes two facts per venue, both read ONLY by Tier 2 inside the 5 % venue
 * sampling band (`@gennety/shared` `venueTier2Fit`):
 *   - `transit_walk_m`     — walking metres to the nearest metro / rail
 *                            entrance (straight line × WALK_DETOUR);
 *   - `pedestrian_nearby`  — a pedestrian street, park, garden or riverside
 *                            promenade within PEDESTRIAN_RADIUS_M;
 * plus `osm_enriched_at`. A null column means "never enriched" and Tier 2 reads
 * it as no signal, so running this is what turns Tier 2 on for a city — and
 * not running it leaves selection exactly as it was.
 *
 * ONE Overpass request per city (entrances + ways inside the catalog's bounding
 * box), distances computed here. Overpass is public infrastructure: be gentle,
 * and never re-run in a loop. Data © OpenStreetMap contributors, ODbL.
 *
 * Usage (from the repo root):
 *   node scripts/enrich-venues-osm.mjs --from-json=scripts/curated-venues.kyiv.approved.json
 *       dry run over a catalog file — no database, prints the distribution
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/enrich-venues-osm.mjs --city=ua:kyiv [--prod] [--apply]
 *       reads active rows of the city from the database; writes only with --apply
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

/** Straight-line → walking distance. City grids and crossings add ~30 %. */
export const WALK_DETOUR = 1.3;
/** Beyond this the entrance is "not nearby" and the exact number stops mattering. */
export const TRANSIT_SEARCH_M = 2500;
/**
 * "Somewhere to walk right outside." Tight on purpose: at 250 m with named
 * footways and gardens counted, 89 % of the Kyiv catalog qualified in the
 * first dry run — a fact true of nearly every venue ranks nothing.
 */
export const PEDESTRIAN_RADIUS_M = 150;
/** A catalog row this far from the city's median point is a data error. */
export const CITY_OUTLIER_KM = 40;
const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
/** Identifies the tool, as Overpass asks. No personal data. */
const USER_AGENT = "gennety-venue-enrichment/1.0 (+https://gennety.com)";

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

const EARTH_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;
export function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The catalog's bounding box, padded by the transit search radius. */
export function paddedBox(venues) {
  const lats = venues.map((v) => v.lat);
  const lngs = venues.map((v) => v.lng);
  const padLat = TRANSIT_SEARCH_M / 111_320;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLng = padLat / Math.max(0.2, Math.cos(toRad(midLat)));
  return {
    south: Math.min(...lats) - padLat,
    west: Math.min(...lngs) - padLng,
    north: Math.max(...lats) + padLat,
    east: Math.max(...lngs) + padLng,
  };
}

function overpassQuery(box) {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  return `[out:json][timeout:180];
(
  node["railway"="subway_entrance"](${bbox});
  node["railway"="train_station_entrance"](${bbox});
  node["public_transport"="station"]["station"="subway"](${bbox});
  node["railway"="station"]["station"="subway"](${bbox});
)->.transit;
.transit out;
(
  way["highway"="pedestrian"](${bbox});
  way["leisure"="park"](${bbox});
  relation["leisure"="park"](${bbox});
)->.walk;
.walk out geom qt;`;
}

/**
 * The public instance answers 429/504 under load. Three attempts, 20 s then
 * 40 s apart — enough to ride out a busy minute, never a hammering loop.
 */
async function fetchOverpass(box) {
  const waits = [20_000, 40_000];
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: overpassQuery(box) }),
      signal: AbortSignal.timeout(240_000),
    });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status === 502 || response.status === 504;
    if (!retryable || attempt >= waits.length) {
      throw new Error(`Overpass answered ${response.status}`);
    }
    console.warn(`Overpass answered ${response.status}; retrying in ${waits[attempt] / 1000} s`);
    await new Promise((done) => setTimeout(done, waits[attempt]));
  }
}

/** Split the Overpass answer into entrance points and walkable geometry points. */
export function splitElements(elements) {
  const transit = [];
  const walkPoints = [];
  for (const el of elements) {
    if (el.type === "node" && typeof el.lat === "number") {
      transit.push({ lat: el.lat, lng: el.lon });
      continue;
    }
    const collect = (geometry) => {
      for (const point of geometry ?? []) {
        if (typeof point.lat === "number") walkPoints.push({ lat: point.lat, lng: point.lon });
      }
    };
    if (el.type === "way") collect(el.geometry);
    if (el.type === "relation") for (const member of el.members ?? []) collect(member.geometry);
  }
  return { transit, walkPoints };
}

/** The two facts for one venue. */
export function factsFor(venue, transit, walkPoints) {
  let nearest = Infinity;
  for (const point of transit) nearest = Math.min(nearest, haversineM(venue, point));
  const transitWalkM =
    nearest <= TRANSIT_SEARCH_M ? Math.round(nearest * WALK_DETOUR) : null;
  let pedestrianNearby = false;
  for (const point of walkPoints) {
    if (haversineM(venue, point) <= PEDESTRIAN_RADIUS_M) {
      pedestrianNearby = true;
      break;
    }
  }
  return { transitWalkM, pedestrianNearby };
}

/**
 * Drop rows implausibly far from the rest (a Lviv venue in the Kyiv file) —
 * one of them stretches the Overpass box across the country.
 */
export function withoutOutliers(venues) {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const center = { lat: median(venues.map((v) => v.lat)), lng: median(venues.map((v) => v.lng)) };
  const kept = venues.filter((v) => haversineM(center, v) <= CITY_OUTLIER_KM * 1000);
  const dropped = venues.length - kept.length;
  if (dropped > 0) {
    console.warn(`⚠ ${dropped} venue(s) more than ${CITY_OUTLIER_KM} km from the city centre left untouched`);
  }
  return kept;
}

function summarize(results) {
  const buckets = { "≤400": 0, "401–800": 0, "801–1200": 0, ">1200": 0, "none": 0 };
  let pedestrian = 0;
  for (const { transitWalkM, pedestrianNearby } of results) {
    if (transitWalkM === null) buckets.none += 1;
    else if (transitWalkM <= 400) buckets["≤400"] += 1;
    else if (transitWalkM <= 800) buckets["401–800"] += 1;
    else if (transitWalkM <= 1200) buckets["801–1200"] += 1;
    else buckets[">1200"] += 1;
    if (pedestrianNearby) pedestrian += 1;
  }
  console.log(`venues: ${results.length}`);
  console.log("transit walk (m):", buckets);
  console.log(`pedestrian street / park within ${PEDESTRIAN_RADIUS_M} m: ${pedestrian}`);
}

async function main() {
  const fromJson = args.get("from-json");
  const apply = args.get("apply") === "true";
  let venues;
  let prisma = null;

  if (fromJson) {
    if (apply) {
      console.error("✗ --apply writes the database; it cannot be combined with --from-json.");
      process.exit(1);
    }
    const rows = JSON.parse(readFileSync(resolve(root, fromJson), "utf8"));
    venues = rows
      .filter((row) => typeof row.lat === "number" && typeof row.lng === "number")
      .map((row) => ({ id: row.placeId ?? row.name, name: row.name, lat: row.lat, lng: row.lng }));
  } else {
    const city = args.get("city");
    if (!city) {
      console.error("✗ Pass --city=<cityKey> (e.g. ua:kyiv) or --from-json=<file>.");
      process.exit(1);
    }
    if (args.get("prod") !== "true") loadEnvFile(resolve(root, ".env.local"), true);
    loadEnvFile(resolve(root, ".env"), false);
    ({ prisma } = await import("@gennety/db"));
    venues = await prisma.curatedVenue.findMany({
      where: { cityKey: city, active: true },
      select: { id: true, name: true, lat: true, lng: true },
    });
  }

  venues = withoutOutliers(venues);
  if (venues.length === 0) {
    console.log("No venues — nothing to do.");
    return;
  }
  const box = paddedBox(venues);
  console.log(`Overpass: one request for ${venues.length} venues, box ${JSON.stringify(box)}`);
  const answer = await fetchOverpass(box);
  const { transit, walkPoints } = splitElements(answer.elements ?? []);
  console.log(`OSM: ${transit.length} transit entrances, ${walkPoints.length} walkable geometry points`);
  if (transit.length === 0) {
    // A city with no metro is real (Odesa); a Kyiv answer with none is a broken
    // query. Refuse to write "far from transit" everywhere on a bad answer.
    console.warn("⚠ No transit entrance in the box — transit_walk_m will be null for every venue.");
  }

  const results = venues.map((venue) => ({ venue, ...factsFor(venue, transit, walkPoints) }));
  summarize(results);

  if (!prisma) return;
  if (!apply) {
    console.log("Dry run — pass --apply to write.");
    await prisma.$disconnect();
    return;
  }
  const now = new Date();
  let written = 0;
  for (const { venue, transitWalkM, pedestrianNearby } of results) {
    await prisma.curatedVenue.update({
      where: { id: venue.id },
      data: { transitWalkM, pedestrianNearby, osmEnrichedAt: now },
    });
    written += 1;
  }
  console.log(`✓ wrote ${written} venues`);
  await prisma.$disconnect();
}

// Compared as paths, not URLs: the repo lives under "Gennety Dating", and the
// space is `%20` in `import.meta.url` but not in `argv`.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
