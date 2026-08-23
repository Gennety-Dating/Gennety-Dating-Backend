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
    const domains = byId.get(row.placeId) ?? new Map();
    domains.set(row.universityDomain, row);
    byId.set(row.placeId, domains);
  }

  for (const place of manifest.places) {
    const domains = byId.get(place.placeId) ?? new Map();
    const expectedTier = place.tier ?? "base";
    for (const domain of expectedDomains) {
      if (!domains.has(domain)) {
        fail(`${place.name} (${place.placeId}) is missing for ${domain}`);
      }
      const row = domains.get(domain);
      if ((row.tier ?? "base") !== expectedTier) {
        fail(
          `${place.name} (${place.placeId}) has tier ${row.tier ?? "base"} for ${domain}, expected ${expectedTier}`,
        );
      }
      // The manifest's `always_open` mark must survive into the row, for the
      // same reason the tier above must: a rebuild regenerates these rows from
      // Places, and Places has no opinion about a street or an embankment. A
      // dropped mark is invisible — the row still reads as a healthy park and
      // is simply never assigned again.
      if ((row.hoursConfidence ?? null) !== (place.hoursConfidence ?? null)) {
        fail(
          `${place.name} (${place.placeId}) has hoursConfidence ${row.hoursConfidence ?? "none"} for ${domain}, expected ${place.hoursConfidence ?? "none"}`,
        );
      }
    }
  }

  // Not a failure: a venue can legitimately have neither (the botanical garden
  // is gated and ticketed, so leaving it unassignable is the correct answer).
  // But it is never something to discover from a silent absence of dates, so
  // the operator is told which rows the selector will drop.
  const unassignable = manifest.places.filter((place) => {
    if (place.hoursConfidence) return false;
    const row = byId.get(place.placeId)?.values().next().value;
    return !row?.openingHours || row?.utcOffsetMinutes == null;
  });
  if (unassignable.length > 0) {
    console.warn(
      `! ${unassignable.length} place(s) have no hours and no hoursConfidence, so V2 will never assign them: ${unassignable.map((p) => p.name).join(", ")}`,
    );
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

/**
 * Collect EVERY problem with a place rather than exiting on the first. A
 * 200-place manifest re-validated one failure per run costs one full Places
 * sweep per fix; the operator needs the whole list in one pass.
 */
function validatePlace(config, details) {
  const problems = [];
  if (details.businessStatus !== "OPERATIONAL") {
    if (!(config.allowMissingStatus && details.businessStatus == null)) {
      problems.push(
        `status is ${details.businessStatus ?? "missing"}, expected OPERATIONAL`,
      );
    }
  }

  const qualityOverride = config.allowQualityOverride === true;
  if (!qualityOverride && details.rating != null && details.rating < 4) {
    problems.push(`rating ${details.rating} is below 4.0`);
  }
  if (
    !qualityOverride &&
    details.userRatingCount != null &&
    details.userRatingCount < 30
  ) {
    problems.push(`only ${details.userRatingCount} reviews`);
  }

  // The ≤ MODERATE cap protects the AUTOMATIC first assignment, which only
  // ever picks `base`. `premium` and `alternative` are board-only inventory the
  // couple opts into themselves, so neither is held to the student price cap.
  const food = new Set(["cafe", "coffee_shop", "restaurant", "lounge"]);
  if (
    config.tier !== "premium" &&
    config.tier !== "alternative" &&
    food.has(config.category) &&
    ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"].includes(
      details.priceLevel,
    )
  ) {
    problems.push(`price level ${details.priceLevel} is not student-friendly`);
  }
  if (
    typeof details.location?.latitude !== "number" ||
    typeof details.location?.longitude !== "number"
  ) {
    problems.push("missing coordinates");
  }

  // `hoursConfidence` is the operator's declaration that a venue needs no
  // opening hours, and the runtime honours exactly two values
  // (`venue-intent-v2.ts` → the hours pre-check). A typo resolves to neither,
  // which is indistinguishable from `unknown` — i.e. the row keeps looking
  // healthy in the catalog and is silently never assigned. That is the one
  // failure this field exists to end, so it is checked rather than trusted.
  // `unknown` is allowed and means the opposite: the operator looked and
  // decided this venue must stay unassignable until it has real hours (the
  // botanical garden is gated and ticketed). Saying so explicitly is what keeps
  // that decision from reading as an oversight the next person "fixes".
  if (
    config.hoursConfidence != null &&
    !["always_open", "operator_confirmed", "unknown"].includes(
      config.hoursConfidence,
    )
  ) {
    problems.push(
      `hoursConfidence "${config.hoursConfidence}" is not always_open, operator_confirmed or unknown`,
    );
  }
  return problems;
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

  // A run with no flag is a PLAN, not a preview (2026-08-23 — DECISIONS.md).
  //
  // It used to fetch all of `manifest.places` and only then print "Dry run:
  // …", so the thing that reads as a look-before-you-leap cost a full Places
  // sweep — and deploy.md documented running it bare and then again with
  // `--apply`, i.e. paying twice for one catalog edit. Place Details is billed
  // per request, so at 219 places that is 438 billed requests to change one
  // venue's tier. `--check` is the free look; `--apply` is the one that spends.
  if (!apply) {
    console.log(
      `Plan: ${manifest.places.length} Google Place Details requests ` +
        `(1 per place in the manifest), billed per request.\n` +
        `Nothing was fetched. Re-run with --apply to spend them, ` +
        `or --check to validate the catalog locally for free.`,
    );
    return;
  }

  loadEnvFile(resolve(root, ".env.local"), true);
  loadEnvFile(resolve(root, ".env"), false);
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) fail("PLACES_API_KEY is required.");

  const details = await mapWithConcurrency(
    manifest.places,
    5,
    async (place) => fetchPlace(apiKey, place),
  );

  const problems = manifest.places.flatMap((place, index) =>
    validatePlace(place, details[index]).map(
      (problem) => `${place.name} (${place.placeId}): ${problem}`,
    ),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`x ${problem}`);
    fail(`${problems.length} place(s) failed validation; fix the manifest and re-run.`);
  }

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

  // Venue Intent V2 facets are NOT derivable from Places — they come from the
  // `backfill-venue-facets` pass. Rebuilding a row must carry them over, or a
  // re-sync silently blinds every existing venue to the ambience chips and the
  // indoor/outdoor hard filter.
  const facetsByRow = new Map(
    catalog.map((row) => [
      `${row.placeId}|${row.universityDomain}`,
      {
        facetTags: row.facetTags ?? [],
        hardCapabilities: row.hardCapabilities ?? [],
      },
    ]),
  );

  const additionsByDomain = new Map(
    manifest.universityDomains.map((domain) => [domain, []]),
  );
  for (let index = 0; index < manifest.places.length; index++) {
    const config = manifest.places[index];
    const place = details[index];
    for (const universityDomain of manifest.universityDomains) {
      const carried = facetsByRow.get(`${place.id ?? config.placeId}|${universityDomain}`);
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
        tier: config.tier ?? "base",
        vibeTags: config.vibeTags,
        facetTags: carried?.facetTags ?? [],
        hardCapabilities: carried?.hardCapabilities ?? [],
        utcOffsetMinutes: place.utcOffsetMinutes ?? null,
        openingHours: place.regularOpeningHours ?? null,
        // Same reason as the facets above, one field later: Places returns no
        // hours for public space (a street, an embankment, a park), and the V2
        // selector drops a row whose hours are unknown. The operator marks
        // those `always_open` by hand — and a rebuild without this line quietly
        // reverted the mark, because `retained` keeps only rows the manifest
        // does NOT own, so every marked venue is rebuilt from Places on every
        // `--apply`. Written only when the manifest sets it, so an ordinary row
        // keeps deriving it at import (`seed-venues.mjs`) and the catalog diff
        // stays the size of the change.
        ...(config.hoursConfidence
          ? { hoursConfidence: config.hoursConfidence }
          : {}),
        // The reason a venue carries an unusual mark, carried for the same
        // reason as the mark itself. A note that survives one review and dies
        // at the next re-sync is worse than none: the row goes back to looking
        // like an oversight, and the next operator "fixes" the decision.
        ...(config.reviewNote ? { reviewNote: config.reviewNote } : {}),
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
