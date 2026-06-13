#!/usr/bin/env node
/**
 * Reconcile the reviewed Kyiv expansion manifest into the replayable approved
 * venue catalog. Google Place ids are the stable identity; live details refresh
 * names, addresses, coordinates, Maps links, ratings, and opening hours.
 *
 * Usage:
 *   pnpm sync-venues:kyiv
 *   pnpm sync-venues:kyiv --apply
 *   pnpm sync-venues:kyiv --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(
  root,
  "scripts/curated-venues.kyiv.expansion.json",
);
const catalogPath = resolve(
  root,
  "scripts/curated-venues.kyiv.approved.json",
);
const apply = process.argv.includes("--apply");
const check = process.argv.includes("--check");

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

function fail(message) {
  console.error(`x ${message}`);
  process.exit(1);
}

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function isBlockedName(name, manifest) {
  const candidate = normalized(name);
  return manifest.blockedBrands.some((brand) =>
    (brand.aliases ?? [brand.name]).some((alias) =>
      candidate.includes(normalized(alias)),
    ),
  );
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertCatalog(catalog, manifest) {
  const expectedDomains = new Set(manifest.universityDomains);
  const expectedIds = new Set(manifest.places.map((place) => place.placeId));
  const excludedIds = new Set(
    manifest.excludedPlaces.map((place) => place.placeId),
  );
  const byId = new Map();

  for (const row of catalog) {
    if (isBlockedName(row.name, manifest)) {
      fail(`Blocked venue remains in catalog: ${row.name}`);
    }
    if (excludedIds.has(row.placeId)) {
      fail(`Rejected venue remains in catalog: ${row.name} (${row.placeId})`);
    }
    if (!expectedIds.has(row.placeId)) continue;
    const domains = byId.get(row.placeId) ?? new Set();
    domains.add(row.universityDomain);
    byId.set(row.placeId, domains);
  }

  for (const place of manifest.places) {
    const domains = byId.get(place.placeId) ?? new Set();
    for (const domain of expectedDomains) {
      if (!domains.has(domain)) {
        fail(`${place.name} (${place.placeId}) is missing for ${domain}`);
      }
    }
  }
  console.log(
    `OK: ${manifest.places.length} expansion places cover ${expectedDomains.size} domains; blocked/rejected places absent.`,
  );
}

async function fetchPlace(apiKey, place) {
  const fields = [
    "id",
    "displayName",
    "formattedAddress",
    "location",
    "googleMapsUri",
    "businessStatus",
    "rating",
    "userRatingCount",
    "priceLevel",
    "primaryType",
    "types",
    "regularOpeningHours",
    "utcOffsetMinutes",
  ].join(",");
  const url = new URL(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(place.placeId)}`,
  );
  url.searchParams.set("languageCode", "uk");
  url.searchParams.set("regionCode", "UA");
  const response = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fields,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${place.name}: Place Details returned ${response.status}`);
  }
  return response.json();
}

function validatePlace(config, details) {
  if (details.businessStatus !== "OPERATIONAL") {
    if (!(config.allowMissingStatus && details.businessStatus == null)) {
      fail(
        `${config.name}: status is ${details.businessStatus ?? "missing"}, expected OPERATIONAL`,
      );
    }
  }

  const qualityOverride = config.allowQualityOverride === true;
  if (!qualityOverride && details.rating != null && details.rating < 4) {
    fail(`${config.name}: rating ${details.rating} is below 4.0`);
  }
  if (
    !qualityOverride &&
    details.userRatingCount != null &&
    details.userRatingCount < 30
  ) {
    fail(`${config.name}: only ${details.userRatingCount} reviews`);
  }

  const food = new Set(["cafe", "coffee_shop", "restaurant", "lounge"]);
  if (
    food.has(config.category) &&
    ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"].includes(
      details.priceLevel,
    )
  ) {
    fail(
      `${config.name}: price level ${details.priceLevel} is not student-friendly`,
    );
  }
  if (
    typeof details.location?.latitude !== "number" ||
    typeof details.location?.longitude !== "number"
  ) {
    fail(`${config.name}: missing coordinates`);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

async function main() {
  const manifest = loadJson(manifestPath);
  const catalog = loadJson(catalogPath);
  if (check) {
    assertCatalog(catalog, manifest);
    return;
  }

  loadEnvFile(resolve(root, ".env.local"), true);
  loadEnvFile(resolve(root, ".env"), false);
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) fail("PLACES_API_KEY is required.");

  const details = await mapWithConcurrency(
    manifest.places,
    5,
    async (place) => {
      const result = await fetchPlace(apiKey, place);
      validatePlace(place, result);
      return result;
    },
  );

  const expansionIds = new Set(manifest.places.map((place) => place.placeId));
  const excludedIds = new Set(
    manifest.excludedPlaces.map((place) => place.placeId),
  );
  const retained = catalog.filter(
    (row) =>
      !isBlockedName(row.name, manifest) &&
      !expansionIds.has(row.placeId) &&
      !excludedIds.has(row.placeId),
  );

  const additionsByDomain = new Map(
    manifest.universityDomains.map((domain) => [domain, []]),
  );
  for (let index = 0; index < manifest.places.length; index++) {
    const config = manifest.places[index];
    const place = details[index];
    for (const universityDomain of manifest.universityDomains) {
      additionsByDomain.get(universityDomain).push({
        approved: true,
        universityDomain,
        name: config.name ?? place.displayName?.text,
        address: place.formattedAddress,
        lat: place.location.latitude,
        lng: place.location.longitude,
        googleMapsUri: place.googleMapsUri ?? null,
        placeId: place.id ?? config.placeId,
        category: config.category,
        priority: config.priority,
        vibeTags: config.vibeTags,
        utcOffsetMinutes: place.utcOffsetMinutes ?? null,
        openingHours: place.regularOpeningHours ?? null,
        _rating: place.rating ?? null,
        _reviews: place.userRatingCount ?? null,
        _priceLevel: place.priceLevel ?? null,
        _primaryType: place.primaryType ?? null,
      });
    }
  }

  const reconciled = [...retained];
  for (const domain of manifest.universityDomains) {
    reconciled.push(...additionsByDomain.get(domain));
  }

  const removed = catalog.length - retained.length;
  const added = manifest.places.length * manifest.universityDomains.length;
  console.log(
    `${apply ? "Applying" : "Dry run"}: retain ${retained.length}, remove/replace ${removed}, add ${added}; final ${reconciled.length}.`,
  );
  if (!apply) {
    console.log("Pass --apply to write the approved catalog.");
    return;
  }

  writeFileSync(catalogPath, `${JSON.stringify(reconciled, null, 2)}\n`, "utf8");
  assertCatalog(reconciled, manifest);
}

main().catch((error) => fail(error?.message ?? String(error)));
