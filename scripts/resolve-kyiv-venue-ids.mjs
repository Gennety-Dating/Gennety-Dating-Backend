#!/usr/bin/env node
/**
 * Resolve an operator-supplied list of Kyiv venue NAMES into stable Google
 * Place ids, so they can be reviewed and folded into the replayable expansion
 * manifest (`curated-venues.kyiv.expansion.json`).
 *
 * This is the step BEFORE `pnpm sync-venues:kyiv`: that script requires place
 * ids and fails hard on anything below the quality gate, so a raw name list has
 * to be resolved and triaged first.
 *
 * Input:  scripts/curated-venues.kyiv.additions.json
 * Output: scripts/curated-venues.kyiv.additions.resolved.json  (review artifact)
 *
 * Usage:
 *   pnpm resolve-venues:kyiv
 *   pnpm resolve-venues:kyiv --write
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const inputPath = resolve(root, "scripts/curated-venues.kyiv.additions.json");
const outputPath = resolve(
  root,
  "scripts/curated-venues.kyiv.additions.resolved.json",
);
const manifestPath = resolve(root, "scripts/curated-venues.kyiv.expansion.json");
const catalogPath = resolve(root, "scripts/curated-venues.kyiv.approved.json");
const write = process.argv.includes("--write");

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

const CATEGORY_BY_TYPE = new Map(
  Object.entries({
    coffee_shop: "coffee_shop",
    cafe: "cafe",
    tea_house: "cafe",
    bakery: "cafe",
    dessert_shop: "cafe",
    ice_cream_shop: "cafe",
    chocolate_shop: "cafe",
    breakfast_restaurant: "cafe",
    brunch_restaurant: "cafe",
    sandwich_shop: "cafe",
    bar: "lounge",
    wine_bar: "lounge",
    pub: "lounge",
    bar_and_grill: "restaurant",
    night_club: "lounge",
    park: "park",
    museum: "museum",
    art_gallery: "museum",
  }),
);

/** Places `primaryType`/`types` → our 6-value category whitelist. */
function suggestCategory(place, override) {
  if (override) return override;
  const types = [place.primaryType, ...(place.types ?? [])].filter(Boolean);
  for (const type of types) {
    const mapped = CATEGORY_BY_TYPE.get(type);
    if (mapped) return mapped;
  }
  if (types.some((t) => t.endsWith("_restaurant") || t === "restaurant")) {
    return "restaurant";
  }
  return null;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh",
  з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ъ: "",
  ё: "e",
};

function translit(value) {
  return [...normalized(value)]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

/** Dice coefficient over character bigrams — cheap, script-agnostic once transliterated. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const bigrams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const gram of A) if (B.has(gram)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * How confidently the Places hit is the venue that was actually asked for.
 * Google's text search always answers with SOMETHING, so without this a typo'd
 * or unlisted name silently resolves to an unrelated venue — the worst possible
 * failure here, since the row would then be a real date destination.
 */
export function nameConfidence(requested, resolvedName) {
  return Math.round(similarity(translit(requested), translit(resolvedName)) * 100) / 100;
}

function normalized(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[’'`´]/g, "'")
    .replace(/\s+/g, " ");
}

async function searchText(apiKey, textQuery, config) {
  const fields = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.googleMapsUri",
    "places.businessStatus",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.primaryType",
    "places.types",
  ].join(",");
  const response = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fields,
      },
      body: JSON.stringify({
        textQuery,
        languageCode: "uk",
        regionCode: "UA",
        maxResultCount: 10,
        locationBias: {
          circle: {
            center: {
              latitude: config.center.lat,
              longitude: config.center.lng,
            },
            radius: config.radiusMeters,
          },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `searchText "${textQuery}" returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  const body = await response.json();
  return body.places ?? [];
}

function summarize(place, config, override) {
  return {
    placeId: place.id,
    name: place.displayName?.text ?? null,
    address: place.formattedAddress ?? null,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    businessStatus: place.businessStatus ?? null,
    rating: place.rating ?? null,
    reviews: place.userRatingCount ?? null,
    priceLevel: place.priceLevel ?? null,
    primaryType: place.primaryType ?? null,
    suggestedCategory: suggestCategory(place, override),
    distanceKm:
      place.location?.latitude == null
        ? null
        : Math.round(
            haversineKm(config.center, {
              lat: place.location.latitude,
              lng: place.location.longitude,
            }) * 10,
          ) / 10,
  };
}

/** Below this, the hit is treated as "probably a different venue". */
const NAME_CONFIDENCE_FLOOR = 0.45;

/** Everything the manifest's own gate (`sync-venues:kyiv`) would reject. */
function reviewFlags(entry, known) {
  const flags = [];
  // `acceptMatch` = a human checked this hit (address + type) and confirmed it
  // IS the venue, despite the low score. The score can't recognise a Ukrainian
  // TRANSLATION of an English name ("Très FRANÇAIS" → "Дуже по-французьки").
  if (
    !entry.acceptMatch &&
    entry.nameConfidence != null &&
    entry.nameConfidence < NAME_CONFIDENCE_FLOOR
  ) {
    flags.push(`name-mismatch:${entry.nameConfidence}`);
  }
  if (entry.businessStatus !== "OPERATIONAL") {
    flags.push(`status:${entry.businessStatus ?? "missing"}`);
  }
  if (entry.rating == null || entry.reviews == null) flags.push("quality:missing");
  if (entry.rating != null && entry.rating < 4) flags.push(`rating:${entry.rating}`);
  if (entry.reviews != null && entry.reviews < 30) flags.push(`reviews:${entry.reviews}`);
  if (entry.suggestedCategory == null) flags.push(`category:${entry.primaryType ?? "unknown"}`);
  if (
    entry.tier !== "premium" &&
    ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"].includes(entry.priceLevel)
  ) {
    flags.push(`price:${entry.priceLevel}`);
  }
  if (entry.distanceKm != null && entry.distanceKm > 20) flags.push(`far:${entry.distanceKm}km`);
  if (known.ids.has(entry.placeId)) flags.push("already-in-catalog");
  // A row curated before place ids were captured can only be caught by name.
  else if (known.names.has(normalized(entry.name))) flags.push("name-collision");
  return flags;
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
  const config = JSON.parse(readFileSync(inputPath, "utf8"));
  loadEnvFile(resolve(root, ".env.local"), true);
  loadEnvFile(resolve(root, ".env"), false);
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) fail("PLACES_API_KEY is required.");

  // Anything already curated must not be re-added under a second identity.
  const known = { ids: new Set(), names: new Set() };
  for (const place of JSON.parse(readFileSync(manifestPath, "utf8")).places) {
    known.ids.add(place.placeId);
    known.names.add(normalized(place.name));
  }
  for (const row of JSON.parse(readFileSync(catalogPath, "utf8"))) {
    if (row.placeId) known.ids.add(row.placeId);
    known.names.add(normalized(row.name));
  }

  const resolved = await mapWithConcurrency(config.venues, 5, async (venue) => {
    const query = venue.query ?? `${venue.name} Київ`;
    let places;
    try {
      places = await searchText(apiKey, query, config);
    } catch (error) {
      return { input: venue, query, error: error.message, matches: [] };
    }
    const candidates = places.map((place) =>
      summarize(place, config, venue.category),
    );

    if (venue.chain) {
      // `chainMatch` is the real brand substring (the operator's spelling is
      // often not the Google listing's — "Тётка Клара" vs "Пиріжкова Тітка
      // Клара"); `chainExclude` drops sibling brands that merely name-drop it.
      const brand = normalized(venue.chainMatch ?? venue.name);
      const excluded = (venue.chainExclude ?? []).map(normalized);
      const branches = candidates
        .filter((candidate) => {
          const name = normalized(candidate.name);
          if (candidate.businessStatus !== "OPERATIONAL") return false;
          if (!name.includes(brand)) return false;
          return !excluded.some((token) => name.includes(token));
        })
        .slice(0, venue.maxBranches ?? 10);
      return {
        input: venue,
        query,
        matches: branches.map((branch) => {
          const entry = {
            ...branch,
            tier: venue.tier ?? "base",
            acceptMatch: venue.acceptMatch === true,
            nameConfidence: nameConfidence(venue.chainMatch ?? venue.name, branch.name),
          };
          return { ...entry, flags: reviewFlags(entry, known) };
        }),
        alternates: [],
      };
    }

    // Prefer the best NAME match among the top hits over Google's own ranking:
    // a generic query ("Perfetto Київ") often ranks a busier unrelated place
    // first, and a wrong row here becomes a real date destination.
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        tier: venue.tier ?? "base",
        acceptMatch: venue.acceptMatch === true,
        nameConfidence: nameConfidence(venue.name, candidate.name),
      }))
      .sort((a, b) => b.nameConfidence - a.nameConfidence);
    const top = scored[0] ?? null;
    return {
      input: venue,
      query,
      matches: top ? [{ ...top, flags: reviewFlags(top, known) }] : [],
      alternates: scored.slice(1, 4),
    };
  });

  const flat = resolved.flatMap((r) => r.matches);
  const missing = resolved.filter((r) => r.matches.length === 0);
  const flagged = flat.filter((m) => m.flags.length > 0);

  console.log(
    `Resolved ${flat.length} places from ${config.venues.length} inputs; ${missing.length} unresolved, ${flagged.length} flagged for review.`,
  );
  for (const entry of missing) {
    console.log(`  ! no match: ${entry.input.name}${entry.error ? ` (${entry.error})` : ""}`);
  }
  for (const entry of flagged) {
    console.log(`  ? ${entry.name} — ${entry.flags.join(", ")}`);
  }

  if (!write) {
    console.log("\nPass --write to save the review artifact.");
    return;
  }
  writeFileSync(outputPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outputPath}`);
}

main().catch((error) => fail(error?.message ?? String(error)));
