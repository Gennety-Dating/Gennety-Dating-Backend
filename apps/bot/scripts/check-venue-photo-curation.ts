/**
 * Check that the audited photo choice still matches Google's live answers:
 * for each curated place, how many approved photos are found under today's
 * names. Read-only — one Place Details request (`photos` mask) per place.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/check-venue-photo-curation.ts [limit]
 *
 * A place below `CURATED_PHOTOS_MIN_SHOWN` is being topped up with unreviewed
 * photos — time to re-audit it.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { VENUE_PHOTO_CURATION } = await import("../src/services/venue-photo-curation.data.js");
const { photoFingerprints, CURATED_PHOTOS_MIN_SHOWN } = await import("../src/services/venue-photo-curation.js");

const apiKey = process.env.PLACES_API_KEY;
if (!apiKey) throw new Error("PLACES_API_KEY is not set");
const limit = Number(process.argv[2] ?? Infinity);

let full = 0;
let partial = 0;
let drifted = 0;
for (const [placeId, audit] of Object.entries(VENUE_PHOTO_CURATION).slice(0, limit)) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "photos" },
  });
  if (!res.ok) {
    console.warn(`${audit.name}: HTTP ${res.status}`);
    continue;
  }
  const body = (await res.json()) as { photos?: Parameters<typeof photoFingerprints>[0] };
  const live = new Set(photoFingerprints(body.photos ?? []));
  const found = audit.show.filter((fp) => live.has(fp)).length;
  if (found === audit.show.length) full++;
  else if (found >= CURATED_PHOTOS_MIN_SHOWN) partial++;
  else drifted++;
  if (found < audit.show.length) console.log(`${audit.name}: ${found}/${audit.show.length} approved photos found`);
}
console.log(`all found: ${full}, some missing: ${partial}, below ${CURATED_PHOTOS_MIN_SHOWN} (re-audit): ${drifted}`);
