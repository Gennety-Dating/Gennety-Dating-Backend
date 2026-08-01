// Live smoke test for the season/weather + observability work — hits the REAL
// Open-Meteo API and the dev DB, no mocks. One-off verification script, not a
// test file (see VENUE_ENGINE_IMPROVEMENT_PLAN.md §5.3 / Часть 6).
//
// Run: VENUE_SEASON_WEATHER_ENABLED=true ./apps/bot/node_modules/.bin/tsx apps/bot/scripts/dev/smoke-venue-engine.ts
import { fetchWeatherForecast } from "../../src/services/weather.js";
import { venueContextMultiplier, venueExposureOf, seasonalRelevance } from "@gennety/shared";
import { computeVenueConcentration, parsePoolSizes } from "../../src/admin/utils/venue-concentration.js";
import { prisma } from "@gennety/db";

console.log("=== 1. Pure functions (no network, no DB) ===");
console.log("seasonalRelevance(outdoor, [], winter=1):", seasonalRelevance("outdoor", [], 1));
console.log("seasonalRelevance(outdoor, [], summer=7):", seasonalRelevance("outdoor", [], 7));
console.log("seasonalRelevance(indoor, [], winter=1):", seasonalRelevance("indoor", [], 1));
console.log("venueExposureOf(null, 'park'):", venueExposureOf(null, "park"));
console.log(
  "venueExposureOf(null, 'restaurant'):",
  venueExposureOf(null, "restaurant"),
  "(must be 'unknown' — never guessed for non-park categories)",
);

console.log("\n=== 2. Weather — REAL Open-Meteo call for Kyiv, ~2h from now ===");
const at = new Date(Date.now() + 2 * 60 * 60 * 1000);
const snapshot = await fetchWeatherForecast(50.4501, 30.5234, at, "ua:kyiv-smoke");
if (snapshot) {
  console.log("Live Kyiv forecast:", snapshot);
  const mult = venueContextMultiplier("outdoor", ["scenic"], at.getUTCMonth() + 1, snapshot);
  console.log("Context multiplier for an outdoor scenic venue right now:", mult);
} else {
  console.log(
    "null — either VENUE_SEASON_WEATHER_ENABLED wasn't 'true' in the shell before this " +
      "process started, or Open-Meteo is unreachable from this network.",
  );
}

console.log("\n=== 3. Admin concentration aggregation against the dev DB ===");
const rows = await prisma.venueSelectionLog.findMany({
  select: { cityKey: true, selectedPlaceId: true, failureReason: true, topCandidates: true },
  take: 100,
  orderBy: { createdAt: "desc" },
});
console.log(`Found ${rows.length} venue_selection_logs rows in the dev DB.`);
const parsed = rows.map((r) => ({
  cityKey: r.cityKey,
  selectedPlaceId: r.selectedPlaceId,
  failureReason: r.failureReason,
  poolSizes: parsePoolSizes(r.topCandidates),
}));
const cities = computeVenueConcentration(parsed);
console.log("Aggregated cities:", JSON.stringify(cities, null, 2));

await prisma.$disconnect();
console.log("\n=== done ===");
