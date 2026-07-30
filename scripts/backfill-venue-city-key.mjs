#!/usr/bin/env node
/**
 * Backfill `curated_venues.city_key` for rows seeded before the column existed.
 *
 * Why this is needed: Venue Intent V2 scopes curated inventory by `cityKey`
 * (`services/venue-intent-v2.ts`), falling back to `universityDomain` ONLY when
 * the pair has no `homeCityKey`. Since a shared dating city is a hard matching
 * filter, every real pair HAS one — so a row with `city_key IS NULL` is never
 * reachable by the automatic venue assignment. It looks healthy in the table and
 * contributes nothing.
 *
 * Assignment is by GEOGRAPHY, not by university domain or file name: each row is
 * snapped to the nearest known city centre, and only accepted when it is both
 * comfortably inside that city (<= NEAR_KM) and unambiguous (the runner-up is at
 * least AMBIGUITY_MARGIN_KM further away). Anything else is reported and left
 * alone for a human — a wrong `city_key` is worse than a null one, because a
 * null row is merely invisible while a wrong one surfaces a venue in a city it
 * is not in.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/backfill-venue-city-key.mjs           # dry run
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/backfill-venue-city-key.mjs --apply
 *
 * Targets whichever DB `DATABASE_URL` points at, with the repo's usual
 * precedence (`.env.local` over `.env`). Pass `--prod` to ignore `.env.local`
 * and act on production explicitly — it will not happen by accident.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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

const useProd = args.get("prod") === "true";
if (!useProd) loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

/**
 * Known city centres. Extend when opening a city — the key must equal the
 * `Profile.homeCityKey` users of that city carry (`buildHomeCityKey`).
 */
const CITY_CENTRES = {
  "ua:kyiv": { lat: 50.4501, lng: 30.5234 },
  "ua:kharkiv": { lat: 49.9935, lng: 36.2304 },
  "ua:odesa": { lat: 46.4825, lng: 30.7233 },
  "ua:lviv": { lat: 49.8397, lng: 24.0297 },
};

/** A venue further than this from its nearest centre is not confidently in it. */
const NEAR_KM = 40;
/** The runner-up city must be at least this much further, or the row is ambiguous. */
const AMBIGUITY_MARGIN_KM = 25;

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function classify(lat, lng) {
  const ranked = Object.entries(CITY_CENTRES)
    .map(([key, c]) => ({ key, km: haversineKm(lat, lng, c.lat, c.lng) }))
    .sort((a, b) => a.km - b.km);
  const [best, runnerUp] = ranked;
  if (best.km > NEAR_KM) return { ok: false, reason: `nearest centre ${best.key} is ${best.km.toFixed(0)}km away` };
  if (runnerUp && runnerUp.km - best.km < AMBIGUITY_MARGIN_KM) {
    return { ok: false, reason: `ambiguous between ${best.key} (${best.km.toFixed(0)}km) and ${runnerUp.key} (${runnerUp.km.toFixed(0)}km)` };
  }
  return { ok: true, cityKey: best.key, km: best.km };
}

async function main() {
  const apply = args.get("apply") === "true";
  const { prisma } = await import("@gennety/db");

  const orphans = await prisma.curatedVenue.findMany({
    where: { cityKey: null },
    select: { id: true, name: true, universityDomain: true, lat: true, lng: true, active: true, tier: true },
  });

  if (orphans.length === 0) {
    console.log("✓ No rows with city_key IS NULL — nothing to backfill.");
    await prisma.$disconnect();
    return;
  }

  console.log(
    `${orphans.length} row(s) with city_key IS NULL.${apply ? "" : " (dry run — pass --apply to write)"}\n`,
  );

  const planned = new Map();
  const skipped = [];
  for (const row of orphans) {
    const verdict = classify(row.lat, row.lng);
    if (!verdict.ok) {
      skipped.push({ row, reason: verdict.reason });
      continue;
    }
    if (!planned.has(verdict.cityKey)) planned.set(verdict.cityKey, []);
    planned.get(verdict.cityKey).push(row);
  }

  for (const [cityKey, rows] of [...planned.entries()].sort()) {
    const domains = [...new Set(rows.map((r) => r.universityDomain))].sort();
    console.log(`  ${cityKey}: ${rows.length} row(s)`);
    console.log(`    domains: ${domains.join(", ")}`);
    console.log(`    sample : ${[...new Set(rows.map((r) => r.name))].slice(0, 4).join(", ")}`);
  }

  if (skipped.length > 0) {
    console.log(`\n  ! ${skipped.length} row(s) left untouched (needs a human):`);
    for (const s of skipped.slice(0, 20)) {
      console.log(`    - ${s.row.name} [${s.row.universityDomain}] — ${s.reason}`);
    }
    if (skipped.length > 20) console.log(`    … and ${skipped.length - 20} more`);
    console.log(`    Add the missing centre to CITY_CENTRES, or set city_key by hand.`);
  }

  if (!apply) {
    console.log(`\nDry run only. Re-run with --apply to write.`);
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  for (const [cityKey, rows] of planned.entries()) {
    const result = await prisma.curatedVenue.updateMany({
      // Re-assert `cityKey: null` so a concurrent writer that already set one
      // is never overwritten by this backfill.
      where: { id: { in: rows.map((r) => r.id) }, cityKey: null },
      data: { cityKey },
    });
    updated += result.count;
    console.log(`  ✓ ${cityKey}: ${result.count} updated`);
  }
  console.log(`\n✓ Backfilled ${updated} row(s). ${skipped.length} left for manual review.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
