#!/usr/bin/env node
/**
 * One-off backfill of Venue Intent V2 facet tags onto the curated Kyiv venue
 * catalog. Today `curated_venues.facet_tags` / `hard_capabilities` are empty
 * for all 516 rows, which means the ambience chips the user picks in the
 * venue-vibe flow (quiet / cozy / lively / design-forward / scenic /
 * romantic) score zero for every real candidate — the vibe never actually
 * changes which place gets picked.
 *
 * Split by risk:
 *   - `indoor` / `outdoor` / `seated` / `walking` feed a HARD filter
 *     (`VenueHardConstraints.setting`), so they are derived deterministically
 *     from `category` (park -> outdoor+walking, everything else -> indoor+
 *     seated; museum additionally gets walking). No LLM guess on a hard gate.
 *   - `ambiences` (quiet/cozy_public/lively/design_forward/scenic/
 *     romantic_public) are a SOFT ranking signal only, so an LLM classifies
 *     them in small batches from name/category/primaryType/price/rating/
 *     existing free-text vibeTags. Low confidence -> empty array, never a
 *     guess dressed up as evidence.
 *   - `hardCapabilities` (dietary/alcohol_free/step_free) are deliberately
 *     NOT touched here — those are hard filters over real accessibility/
 *     dietary needs and need operator evidence, not an LLM guess.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/backfill-venue-facets.mjs [--in=PATH] [--apply]
 *   (dry run by default; --apply writes the JSON file in place)
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}
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

function resolveCliPath(name, fallback) {
  const value = args.get(name);
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(root, value);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const DEFAULT_IN = resolve(root, "scripts/curated-venues.kyiv.approved.json");
const BATCH_SIZE = 18;

// Deterministic, category-derived — these feed a HARD filter, so no LLM here.
const CATEGORY_FORMATS = {
  park: ["outdoor", "walking"],
  museum: ["indoor", "walking"],
  cafe: ["indoor", "seated"],
  coffee_shop: ["indoor", "seated"],
  restaurant: ["indoor", "seated"],
  lounge: ["indoor", "seated"],
};

const AMBIENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "ambiences"],
        properties: {
          index: { type: "integer" },
          ambiences: {
            type: "array",
            maxItems: 3,
            items: {
              type: "string",
              enum: ["quiet", "cozy_public", "lively", "design_forward", "scenic", "romantic_public"],
            },
          },
        },
      },
    },
  },
};

const AMBIENCE_PROMPT = `You are tagging real first-date venues with ambience labels for a matchmaking app.
Return JSON only, matching the schema. For each venue (given name, category, Google primary type, price level, rating, and free-text tags a human curator wrote), pick 0-3 ambience ids that you are reasonably confident describe the PHYSICAL FEEL of the place, based on its name/type/category/existing tags — not on invented details.
Canonical ambience ids and their meaning:
- quiet: calm, low-noise, good for uninterrupted conversation (classic reading cafes, tea rooms, small museums)
- cozy_public: warm, intimate, small/homey seating (small cafes, wine bars, bookshop cafes)
- lively: energetic, buzzy, music/crowd present (bars, lounges, popular restaurants, food halls)
- design_forward: visually striking / architecturally notable / Instagram-aesthetic interior (specialty coffee, concept restaurants, design-forward lounges)
- scenic: notable view or outdoor natural setting (parks, riverside/rooftop spots, embankments)
- romantic_public: candlelit/intimate-dinner feel appropriate for a couple, still a public place (fine-dining restaurants, wine lounges)
If nothing fits confidently, return an empty array for that venue — never force a guess. A venue can have 0, 1, 2, or 3 tags.`;

function categoryFormats(category) {
  const base = CATEGORY_FORMATS[category] ?? ["indoor", "seated"];
  return [...base];
}

async function classifyBatch(callOpenAIJson, batch) {
  const userContent = JSON.stringify(
    batch.map((row, i) => ({
      index: i,
      name: row.name,
      category: row.category,
      primaryType: row._primaryType ?? null,
      priceLevel: row._priceLevel ?? null,
      rating: row._rating ?? null,
      curatorTags: row.vibeTags ?? [],
    })),
  );
  const result = await callOpenAIJson(AMBIENCE_PROMPT, userContent, {
    temperature: 1,
    maxTokens: 2000,
    jsonSchema: { name: "venue_ambience_backfill", schema: AMBIENCE_SCHEMA },
  });
  const byIndex = new Map();
  for (const r of result?.results ?? []) {
    if (Number.isInteger(r.index)) byIndex.set(r.index, Array.isArray(r.ambiences) ? r.ambiences : []);
  }
  return batch.map((_, i) => byIndex.get(i) ?? []);
}

async function main() {
  const inPath = resolveCliPath("in", DEFAULT_IN);
  if (!existsSync(inPath)) fail(`Not found: ${inPath}`);
  const apply = args.get("apply") === "true";

  const rows = JSON.parse(readFileSync(inPath, "utf8"));
  if (!Array.isArray(rows)) fail("Candidates file must be a JSON array.");

  const { callOpenAIJson } = await import("../apps/bot/src/services/openai.js");
  if (!process.env.OPENAI_API_KEY) fail("Missing OPENAI_API_KEY in env.");

  let ambienceCounts = { total: 0, tagged: 0 };
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const ambiences = await classifyBatch(callOpenAIJson, batch);
    batch.forEach((row, i) => {
      row.hardCapabilities = categoryFormats(row.category);
      row.facetTags = ambiences[i];
      ambienceCounts.total += 1;
      if (ambiences[i].length > 0) ambienceCounts.tagged += 1;
    });
    console.log(
      `  batch ${start}-${start + batch.length - 1}/${rows.length}: ${batch.filter((_, i) => ambiences[i].length > 0).length}/${batch.length} tagged`,
    );
  }

  console.log(
    `\n${apply ? "Writing" : "(dry run, not writing)"} — ${ambienceCounts.tagged}/${ambienceCounts.total} venues got at least one ambience tag.`,
  );
  const sample = rows.slice(0, 8).map((r) => ({ name: r.name, category: r.category, facetTags: r.facetTags, hardCapabilities: r.hardCapabilities }));
  console.log(JSON.stringify(sample, null, 2));

  if (apply) {
    writeFileSync(inPath, JSON.stringify(rows, null, 2) + "\n", "utf8");
    console.log(`\n✓ Wrote ${inPath}. Now run: pnpm seed-venues:import --in=${inPath} --apply`);
  } else {
    console.log("\nDry run only. Re-run with --apply to write the file.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
