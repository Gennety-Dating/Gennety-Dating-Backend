/**
 * Write the audited photo choice (`venue-photo-curation.data.ts`) into
 * `curated_venues.photo_refs` now, instead of waiting for the nightly
 * re-validation to reach every place (~9 days for a full Kyiv cycle).
 *
 * Usage (on the droplet, after the bot carrying the curation is deployed):
 *   pnpm --filter @gennety/bot exec tsx scripts/apply-venue-photo-curation.ts           # dry run
 *   pnpm --filter @gennety/bot exec tsx scripts/apply-venue-photo-curation.ts --apply   # write
 *
 * Side effects with --apply: one Place Details request (`photos` mask) per
 * curated place, then `photo_refs` of every row with that place id. Touches no
 * other column. Without --apply it only prints what it would write.
 *
 * A place whose lookup fails or comes back without photos is left alone, the
 * same "no news" rule as the re-validation.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { prisma } = await import("@gennety/db");
const { fetchPlacePhotoNames } = await import("../src/services/venue.js");
const { VENUE_PHOTO_CURATION } = await import("../src/services/venue-photo-curation.data.js");
const { CURATED_PHOTO_REFS_MAX } = await import("../src/services/venue-revalidation.js");

const apply = process.argv.includes("--apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) throw new Error("PLACES_API_KEY is not set");

  let written = 0;
  let skipped = 0;
  let rows = 0;
  for (const [placeId, audit] of Object.entries(VENUE_PHOTO_CURATION)) {
    const refs = await fetchPlacePhotoNames(apiKey, placeId, CURATED_PHOTO_REFS_MAX);
    await sleep(150);
    if (!refs || refs.length === 0) {
      console.warn(`skip ${audit.name} (${placeId}): no photos in the answer`);
      skipped++;
      continue;
    }
    if (apply) {
      const res = await prisma.curatedVenue.updateMany({ where: { placeId }, data: { photoRefs: refs } });
      rows += res.count;
    }
    console.log(`${apply ? "wrote" : "would write"} ${refs.length} photos — ${audit.name}`);
    written++;
  }
  console.log(`${apply ? "applied" : "dry run"}: ${written} places${apply ? `, ${rows} rows` : ""}, ${skipped} skipped`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
