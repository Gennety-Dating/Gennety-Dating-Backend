#!/usr/bin/env node
/**
 * One-off enrichment of `curated_venues` rows that predate the quality/price
 * columns the Venue Intent V2 eligibility gate reads.
 *
 * Why: `evaluateInitialVenuePolicy` rejects a row with a null `rating` /
 * `userRatingCount` as `quality_below_floor`, and a null `priceLevel` as
 * `unknown_price` for every price-evidence category. Rows seeded before those
 * columns existed therefore contribute nothing — they look healthy in the table
 * and are never proposed. The re-validation cron now persists these fields
 * (fixed 2026-07-30), so it will heal rows over time at 30/day; this script is
 * the catch-up pass so a city does not sit dead for two weeks.
 *
 * Deliberately does NOT deactivate anything. It only fills gaps, and reports
 * which rows Places now says are unfit so the decision stays a human one — the
 * ordinary cron applies deactivation on its own schedule.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/backfill-venue-quality.mjs [--prod] [--apply] [--limit=N]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

if (args.get("prod") !== "true") loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

/** Gentle pacing so a few hundred Place Details calls don't burst the quota. */
const DELAY_MS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const apply = args.get("apply") === "true";
  const limit = Number(args.get("limit") ?? "1000");
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) {
    console.error("✗ Missing PLACES_API_KEY in env.");
    process.exit(1);
  }

  const { prisma } = await import("@gennety/db");
  const { fetchPlaceDetails, MIN_RATING, MIN_RATING_COUNT } = await import(
    "../apps/bot/src/services/venue.js"
  );

  const stale = await prisma.curatedVenue.findMany({
    where: {
      active: true,
      placeId: { not: null },
      OR: [{ rating: null }, { userRatingCount: null }, { priceLevel: null }],
    },
    select: {
      id: true, name: true, placeId: true, cityKey: true, category: true,
      rating: true, userRatingCount: true, priceLevel: true,
    },
    take: limit,
  });

  if (stale.length === 0) {
    console.log("✓ Nothing to enrich — every active row already carries quality metadata.");
    await prisma.$disconnect();
    return;
  }

  const byCity = new Map();
  for (const r of stale) byCity.set(r.cityKey ?? "NULL", (byCity.get(r.cityKey ?? "NULL") ?? 0) + 1);
  console.log(
    `${stale.length} row(s) missing quality metadata.${apply ? "" : " (dry run — pass --apply to write)"}`,
  );
  for (const [city, n] of [...byCity].sort()) console.log(`  ${city}: ${n}`);
  console.log(`\nFetching Place Details (${DELAY_MS}ms apart)…\n`);

  let filled = 0;
  let failed = 0;
  const wouldDeactivate = [];
  for (const [i, row] of stale.entries()) {
    let details;
    try {
      details = await fetchPlaceDetails(apiKey, row.placeId);
    } catch (err) {
      failed++;
      console.warn(`  ! ${row.name}: ${err?.message ?? err}`);
      await sleep(DELAY_MS);
      continue;
    }

    const unfit =
      (details.businessStatus != null && details.businessStatus !== "OPERATIONAL") ||
      (details.rating != null && details.rating < MIN_RATING) ||
      (details.userRatingCount != null && details.userRatingCount < MIN_RATING_COUNT);
    if (unfit) {
      wouldDeactivate.push(
        `${row.name} [${row.cityKey}] status=${details.businessStatus} rating=${details.rating} reviews=${details.userRatingCount}`,
      );
    }

    const data = {
      ...(details.rating != null ? { rating: details.rating } : {}),
      ...(details.userRatingCount != null ? { userRatingCount: details.userRatingCount } : {}),
      ...(details.priceLevel != null ? { priceLevel: details.priceLevel } : {}),
      ...(details.primaryType != null ? { primaryType: details.primaryType } : {}),
      ...(details.editorialSummary != null ? { editorialSummary: details.editorialSummary } : {}),
    };
    if (Object.keys(data).length > 0) {
      if (apply) await prisma.curatedVenue.update({ where: { id: row.id }, data });
      filled++;
    }

    if ((i + 1) % 50 === 0) console.log(`  … ${i + 1}/${stale.length}`);
    await sleep(DELAY_MS);
  }

  console.log(`\n${apply ? "✓ Enriched" : "Would enrich"} ${filled} row(s). ${failed} fetch failure(s).`);
  if (wouldDeactivate.length > 0) {
    console.log(
      `\n! ${wouldDeactivate.length} row(s) Places now reports as unfit (closed, or below the ${MIN_RATING}/${MIN_RATING_COUNT} floor).`,
    );
    console.log(`  NOT deactivated here — the re-validation cron owns that decision:`);
    for (const line of wouldDeactivate.slice(0, 25)) console.log(`    - ${line}`);
    if (wouldDeactivate.length > 25) console.log(`    … and ${wouldDeactivate.length - 25} more`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
