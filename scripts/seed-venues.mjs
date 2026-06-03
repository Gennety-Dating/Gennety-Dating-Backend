#!/usr/bin/env node
/**
 * Curated venue seeder (PRODUCT_SPEC §3.7).
 *
 * Two-phase, Places-backed, with a manual review step in between so a human
 * always signs off before a place becomes a real first-date venue:
 *
 *   1. pnpm seed-venues:pull
 *      Reads `scripts/curated-venues.config.json` (university centres), queries
 *      Google Places via the SAME strict quality gate production uses
 *      (`searchVenueCandidates`), and writes
 *      `scripts/curated-venues.candidates.json` with every candidate's metadata
 *      plus an editable `approved` flag (default false), `priority`, `vibeTags`.
 *
 *   2. <hand-edit the candidates file>
 *      Flip `approved: true` on the keepers, tweak `priority` (1 best … 3 ok)
 *      and `vibeTags`, delete the rest.
 *
 *   3. pnpm seed-venues:import
 *      Upserts approved rows into `curated_venues` (idempotent on
 *      domain+name+address) and stamps `lastVerifiedAt = now()`.
 *
 * Run against whichever DB your env points at: `.env.local` (dev) wins over
 * `.env` (prod) exactly like the rest of the toolchain. To seed PRODUCTION,
 * run with prod env (no `.env.local`, or values pointing at prod DATABASE_URL).
 *
 * Usage:
 *   pnpm seed-venues:pull   [--config=PATH] [--out=PATH] [--per-category=8]
 *   pnpm seed-venues:import [--in=PATH] [--apply]
 *
 * `--import` is a dry-run by default; pass `--apply` to write.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Load local dev env before importing anything that constructs Prisma.
loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value = "true"] = arg.slice(2).split("=");
      return [key, value];
    }),
);

const DEFAULT_CONFIG = resolve(root, "scripts/curated-venues.config.json");
const DEFAULT_CANDIDATES = resolve(root, "scripts/curated-venues.candidates.json");
const DEFAULT_CATEGORIES = ["cafe", "coffee_shop", "restaurant", "park", "museum"];
const DEFAULT_RADIUS_M = 4000;
const PER_CATEGORY = Number(args.get("per-category") ?? "8");

function resolveCliPath(name, fallback) {
  const value = args.get(name);
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(root, value);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function pull() {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) fail("Missing PLACES_API_KEY in env.");

  const configPath = resolveCliPath("config", DEFAULT_CONFIG);
  if (!existsSync(configPath)) {
    fail(
      `Config not found: ${configPath}\n  Create it from scripts/curated-venues.config.json (a committed example).`,
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(config) || config.length === 0) {
    fail("Config must be a non-empty array of university entries.");
  }

  const { searchVenueCandidates } = await import("../apps/bot/src/services/venue.js");

  const candidates = [];
  for (const uni of config) {
    const { universityDomain, lat, lng } = uni;
    if (!universityDomain || typeof lat !== "number" || typeof lng !== "number") {
      fail(`Bad config entry (need universityDomain, lat, lng): ${JSON.stringify(uni)}`);
    }
    const categories = uni.categories ?? DEFAULT_CATEGORIES;
    const radiusMeters = uni.radiusMeters ?? DEFAULT_RADIUS_M;
    const defaultPriority = uni.defaultPriority ?? 2;

    for (const category of categories) {
      let found = [];
      try {
        found = await searchVenueCandidates(apiKey, {
          lat,
          lng,
          category,
          keywords: [],
          radiusMeters,
        });
      } catch (err) {
        console.warn(`  ! ${universityDomain}/${category} search failed:`, err?.message ?? err);
        continue;
      }
      const top = found.slice(0, PER_CATEGORY);
      console.log(`  ${universityDomain}/${category}: ${top.length} candidate(s)`);
      for (const c of top) {
        candidates.push({
          approved: false, // <-- flip to true to keep
          universityDomain,
          name: c.name,
          address: c.address,
          lat: c.lat,
          lng: c.lng,
          googleMapsUri: c.googleMapsUri,
          placeId: c.placeId,
          category: c.category,
          priority: defaultPriority,
          vibeTags: [],
          utcOffsetMinutes: c.utcOffsetMinutes,
          openingHours: c.openingHours,
          // review-only context (ignored on import):
          _rating: c.rating,
          _reviews: c.userRatingCount,
          _priceLevel: c.priceLevel,
          _primaryType: c.primaryType,
        });
      }
    }
  }

  const outPath = resolveCliPath("out", DEFAULT_CANDIDATES);
  writeFileSync(outPath, JSON.stringify(candidates, null, 2) + "\n", "utf8");
  console.log(
    `\n✓ Wrote ${candidates.length} candidate(s) to ${outPath}\n  Review, flip "approved": true on keepers, then: pnpm seed-venues:import --apply`,
  );
}

async function importVenues() {
  const inPath = resolveCliPath("in", DEFAULT_CANDIDATES);
  if (!existsSync(inPath)) fail(`Candidates file not found: ${inPath} (run --pull first).`);
  const apply = args.get("apply") === "true";

  const rows = JSON.parse(readFileSync(inPath, "utf8"));
  if (!Array.isArray(rows)) fail("Candidates file must be a JSON array.");

  const { prisma } = await import("@gennety/db");
  const { isValidVenueCategory } = await import(
    "../apps/bot/src/services/curated-venue.js"
  );

  const approved = rows.filter((r) => r.approved === true);
  console.log(`${approved.length}/${rows.length} approved.${apply ? "" : " (dry run — pass --apply to write)"}`);

  let created = 0;
  let updated = 0;
  for (const r of approved) {
    if (!r.universityDomain || !r.name || !r.address) {
      console.warn(`  ! skipping (missing domain/name/address): ${JSON.stringify(r).slice(0, 120)}`);
      continue;
    }
    if (!isValidVenueCategory(r.category)) {
      console.warn(`  ! skipping ${r.name}: invalid category "${r.category}"`);
      continue;
    }
    if (typeof r.lat !== "number" || typeof r.lng !== "number") {
      console.warn(`  ! skipping ${r.name}: missing lat/lng`);
      continue;
    }

    const data = {
      universityDomain: r.universityDomain,
      name: r.name,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      googleMapsUri: r.googleMapsUri ?? null,
      placeId: r.placeId ?? null,
      category: r.category,
      priority: Number.isFinite(r.priority) ? r.priority : 2,
      vibeTags: Array.isArray(r.vibeTags) ? r.vibeTags : [],
      utcOffsetMinutes: Number.isFinite(r.utcOffsetMinutes) ? r.utcOffsetMinutes : null,
      openingHours: r.openingHours ?? null,
      active: true,
      lastVerifiedAt: new Date(),
    };

    if (!apply) {
      console.log(`  would upsert: [${data.universityDomain}] ${data.name} (${data.category}, p${data.priority})`);
      continue;
    }

    // No unique index on (domain, name, address); dedupe via findFirst.
    const existing = await prisma.curatedVenue.findFirst({
      where: {
        universityDomain: data.universityDomain,
        name: data.name,
        address: data.address,
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.curatedVenue.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.curatedVenue.create({ data });
      created++;
    }
  }

  if (apply) {
    console.log(`\n✓ Imported: ${created} created, ${updated} updated.`);
    await prisma.$disconnect();
  }
}

async function main() {
  if (args.has("help") || (!args.has("pull") && !args.has("import"))) {
    console.log(
      "Usage:\n  pnpm seed-venues:pull   [--config=PATH] [--out=PATH] [--per-category=8]\n  pnpm seed-venues:import [--in=PATH] [--apply]",
    );
    process.exit(0);
  }
  if (args.has("pull")) await pull();
  if (args.has("import")) await importVenues();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
