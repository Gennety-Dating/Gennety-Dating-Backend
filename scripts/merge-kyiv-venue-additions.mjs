#!/usr/bin/env node
/**
 * Fold the reviewed output of `resolve-venues:kyiv` into the replayable Kyiv
 * expansion manifest.
 *
 * Accepted places land in `places[]` (the manifest `sync-venues:kyiv` replays);
 * everything the gate refuses lands in `excludedPlaces[]` WITH ITS REASON, so a
 * venue is never silently dropped and a later re-check can tell "we looked at
 * this and said no" apart from "we never saw it".
 *
 * Usage:
 *   pnpm merge-venues:kyiv
 *   pnpm merge-venues:kyiv --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const resolvedPath = resolve(
  root,
  "scripts/curated-venues.kyiv.additions.resolved.json",
);
const manifestPath = resolve(root, "scripts/curated-venues.kyiv.expansion.json");
const inputPath = resolve(root, "scripts/curated-venues.kyiv.additions.json");
const apply = process.argv.includes("--apply");
/**
 * Admit `base` venues Google prices as EXPENSIVE by re-tiering them `premium`
 * instead of dropping them. Off by default: silently promoting a venue past the
 * student price cap is an operator decision, not a script's.
 */
const promoteExpensive = process.argv.includes("--promote-expensive");

/** Free-text vibe tags by Places type — the soft keyword bonus in ranking. */
const VIBE_BY_TYPE = {
  coffee_shop: ["coffee", "casual", "study"],
  cafe: ["coffee", "cozy", "casual"],
  bakery: ["bakery", "coffee", "cozy"],
  dessert_restaurant: ["dessert", "coffee", "cozy"],
  dessert_shop: ["dessert", "coffee", "cozy"],
  ice_cream_shop: ["dessert", "casual", "walk"],
  chocolate_shop: ["dessert", "coffee", "cozy"],
  tea_store: ["tea", "quiet", "cozy"],
  tea_house: ["tea", "quiet", "cozy"],
  breakfast_restaurant: ["brunch", "coffee", "casual"],
  brunch_restaurant: ["brunch", "coffee", "casual"],
  italian_restaurant: ["dinner", "italian", "cozy"],
  pizza_restaurant: ["pizza", "casual", "lively"],
  french_restaurant: ["dinner", "wine", "romantic"],
  european_restaurant: ["dinner", "wine", "cozy"],
  mediterranean_restaurant: ["dinner", "wine", "cozy"],
  spanish_restaurant: ["dinner", "wine", "lively"],
  seafood_restaurant: ["dinner", "seafood", "lively"],
  steak_house: ["dinner", "meat", "lively"],
  barbecue_restaurant: ["dinner", "meat", "lively"],
  hamburger_restaurant: ["casual", "meat", "lively"],
  ukrainian_restaurant: ["dinner", "local", "cozy"],
  eastern_european_restaurant: ["dinner", "hearty", "lively"],
  middle_eastern_restaurant: ["dinner", "hearty", "lively"],
  halal_restaurant: ["dinner", "hearty", "casual"],
  asian_restaurant: ["dinner", "asian", "lively"],
  chinese_restaurant: ["dinner", "asian", "lively"],
  japanese_restaurant: ["dinner", "asian", "quiet"],
  korean_restaurant: ["dinner", "asian", "lively"],
  thai_restaurant: ["dinner", "asian", "lively"],
  vietnamese_restaurant: ["dinner", "asian", "casual"],
  sushi_restaurant: ["dinner", "asian", "quiet"],
  vegan_restaurant: ["lunch", "vegan", "cozy"],
  vegetarian_restaurant: ["lunch", "vegan", "cozy"],
  bar: ["drinks", "evening", "lively"],
  wine_bar: ["wine", "evening", "cozy"],
  pub: ["drinks", "evening", "lively"],
  fine_dining_restaurant: ["dinner", "wine", "romantic"],
};

const VIBE_BY_CATEGORY = {
  cafe: ["coffee", "cozy", "casual"],
  coffee_shop: ["coffee", "casual", "study"],
  restaurant: ["dinner", "cozy", "lively"],
  lounge: ["drinks", "evening", "lively"],
  park: ["walk", "outdoor", "quiet"],
  museum: ["culture", "walk", "quiet"],
};

function vibeTags(match) {
  return (
    VIBE_BY_TYPE[match.primaryType] ??
    VIBE_BY_CATEGORY[match.suggestedCategory] ??
    ["casual"]
  );
}

/** 1 = best first-date spot … 3 = acceptable. Deterministic from public signal. */
function priority(match) {
  if ((match.rating ?? 0) >= 4.6 && (match.reviews ?? 0) >= 300) return 1;
  if ((match.rating ?? 0) >= 4.3) return 2;
  return 3;
}

/**
 * Decide each resolved hit. Mirrors the `sync-venues:kyiv` gate deliberately:
 * anything admitted here must survive that script's own hard validation.
 */
function classify(match, overrides) {
  const override = overrides.has(match.placeId);
  if (match.businessStatus !== "OPERATIONAL") {
    return { ok: false, reason: `Google Places reports ${match.businessStatus ?? "no status"}.` };
  }
  if (match.flags.some((f) => f.startsWith("name-mismatch"))) {
    return { ok: false, reason: "No confident Google Places match for the operator's name." };
  }
  if (match.flags.includes("already-in-catalog")) {
    return { ok: true, tier: match.tier, note: "re-tier", override };
  }
  // The 4.0 / 30-review floor is the same gate that guards the live Places
  // fallback. An operator can waive it per venue (they know the place); the
  // waiver is recorded on the row so `sync-venues:kyiv` replays it explicitly
  // instead of the gate quietly weakening for everyone.
  if (!override) {
    if (match.rating == null || match.reviews == null) {
      return { ok: false, reason: "No public rating on Google Places (quality gate needs one)." };
    }
    if (match.rating < 4) return { ok: false, reason: `Google rating ${match.rating} is below 4.0.` };
    if (match.reviews < 30) return { ok: false, reason: `Only ${match.reviews} Google reviews (min 30).` };
  }
  if (match.suggestedCategory == null) {
    return { ok: false, reason: `Places type "${match.primaryType ?? "unknown"}" is not a date venue category.` };
  }
  const expensive = ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"].includes(
    match.priceLevel,
  );
  // The ≤ MODERATE cap only binds `base`: it protects the automatic first
  // assignment. `premium` and `alternative` are board-only, opted into by the
  // couple, so price is their call.
  if (expensive && match.tier === "base") {
    if (!promoteExpensive) {
      return { ok: false, reason: `Google price level is ${match.priceLevel} (above the base-tier cap).` };
    }
    return { ok: true, tier: "premium", note: "promoted-expensive", override };
  }
  return { ok: true, tier: match.tier, override };
}

function main() {
  const resolved = JSON.parse(readFileSync(resolvedPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const overrides = new Set(
    JSON.parse(readFileSync(inputPath, "utf8")).qualityOverrides?.map((o) => o.placeId) ?? [],
  );

  const existing = new Set(manifest.places.map((p) => p.placeId));
  const excluded = new Map(
    (manifest.excludedPlaces ?? []).map((p) => [p.placeId, p]),
  );

  const added = [];
  const rejected = [];
  const seen = new Set();

  for (const row of resolved) {
    if (row.matches.length === 0) {
      rejected.push({
        name: row.input.name,
        placeId: null,
        reason: "No Google Places listing found for this name in Kyiv.",
      });
      continue;
    }
    for (const match of row.matches) {
      if (seen.has(match.placeId)) continue;
      seen.add(match.placeId);
      const verdict = classify(match, overrides);
      if (!verdict.ok) {
        rejected.push({ name: match.name, placeId: match.placeId, reason: verdict.reason });
        continue;
      }
      added.push({
        placeId: match.placeId,
        name: match.name,
        category: match.suggestedCategory,
        priority: priority(match),
        ...(verdict.tier === "base" ? {} : { tier: verdict.tier }),
        vibeTags: vibeTags(match),
        ...(verdict.override ? { allowQualityOverride: true } : {}),
        _note: verdict.note,
      });
    }
  }

  const fresh = added.filter((p) => !existing.has(p.placeId));
  const retiered = added.filter((p) => existing.has(p.placeId));
  const byTier = {};
  for (const place of added) byTier[place.tier ?? "base"] = (byTier[place.tier ?? "base"] ?? 0) + 1;

  console.log(
    `${apply ? "Applying" : "Dry run"}: ${added.length} accepted (${fresh.length} new, ${retiered.length} already in the manifest), ${rejected.length} rejected.`,
  );
  console.log(`  tiers: ${JSON.stringify(byTier)}`);
  console.log(`  manifest places: ${manifest.places.length} -> ${manifest.places.length + fresh.length}`);
  const reasons = {};
  for (const r of rejected) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  x ${count} — ${reason}`);
  }

  if (!apply) {
    console.log("\nPass --apply to write the manifest.");
    return;
  }

  for (const place of added) {
    const { _note, ...entry } = place;
    const index = manifest.places.findIndex((p) => p.placeId === entry.placeId);
    if (index >= 0) manifest.places[index] = entry;
    else manifest.places.push(entry);
    excluded.delete(entry.placeId);
  }
  for (const reject of rejected) {
    if (!reject.placeId) continue;
    excluded.set(reject.placeId, reject);
  }
  manifest.checkedAt = new Date().toISOString().slice(0, 10);
  manifest.excludedPlaces = [...excluded.values()];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `\nWrote ${manifestPath} (${manifest.places.length} places, ${manifest.excludedPlaces.length} excluded).`,
  );
}

main();
