#!/usr/bin/env node
// Rescale `Profile.standbyCount` / `missedWeeks` between cadence profiles.
//
// This is the ONE step of a `DROP_CADENCE` rollback that is not a single env
// var, and it must be run BEFORE the flip back — see
// DAILY_MATCHING_IMPLEMENTATION_PLAN.md §3.1 block C1 and §6.
//
// Why it is needed at all
// ----------------------
// `standbyCount` counts CYCLES a user sat unpaired, and the starvation bonus is
// `alpha * standbyCount` capped at 0.25. Both cadence profiles are calibrated to
// saturate at the same ~35 days, by moving alpha rather than the counter:
//
//     weekly: alpha 0.05      -> 5 cycles  = 5 weeks = 35 days
//     daily:  alpha 0.05 / 7  -> 35 cycles = 35 days
//
// So the COUNTER means different things in the two profiles: 14 is a fortnight
// under weekly and a fortnight under daily too — but as 2 cycles vs 14 cycles.
// Flip `DROP_CADENCE=daily` -> `weekly` without rescaling and every accumulated
// count is re-read at 7x its intended weight: a user at 14 gets
// `0.05 * 14 = 0.7`, clamped to the 0.25 cap. Everyone lands on the cap at once,
// which does not merely inflate priority — it DELETES it, because a bonus that
// is identical for every starved user can no longer order them.
//
// Usage
// -----
//   pnpm --filter @gennety/bot exec tsx ../../scripts/normalize-standby-count.mjs --to=weekly
//   pnpm --filter @gennety/bot exec tsx ../../scripts/normalize-standby-count.mjs --to=weekly --apply
//   pnpm --filter @gennety/bot exec tsx ../../scripts/normalize-standby-count.mjs --to=daily --apply --prod
//
// Dry run by default: prints the full before/after distribution and writes
// nothing. `--apply` performs the update inside a transaction.
//
//   --to=weekly   divide by 7 (rolling BACK from a daily pilot). The common case.
//   --to=daily    multiply by 7 (rolling FORWARD, only if a pilot is resumed).
//   --prod        load production `.env` only (its DATABASE_URL wins).
//   --force       skip the direction guard (see below). Almost never correct.
//
// RUN IT BEFORE FLIPPING `DROP_CADENCE`, not after. The rescale is unconditional
// arithmetic with no idea what scale the data is already on, so running it in
// the wrong direction — or twice — destroys priority rather than restoring it.
// The guard uses `DROP_CADENCE` as the statement of which scale the counters
// were written under and refuses when it disagrees with `--to`.
//
// Rounding is deliberate and stated in the output: `--to=weekly` rounds DOWN
// (`floor`), so a partial week never grants priority the user has not waited
// for. It also floors at 0, and a user with 1..6 daily cycles correctly becomes
// 0 — they had not yet waited a full weekly cycle.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Cycles per week in each profile — the whole conversion factor. */
const RATIO = 7;

/**
 * Pure, so the arithmetic — the one part that must not be wrong — is checkable
 * without a database. Exported above the CLI guard below for exactly that.
 *
 * Rounding DOWN when scaling to weekly is the safe direction: it can only ever
 * under-state how long someone waited, and an under-stated wait costs a little
 * priority, while an over-stated one hands out the cap.
 */
export function rescaleStandby(value, target) {
  const n = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (n === 0) return 0;
  return target === "weekly" ? Math.floor(n / RATIO) : n * RATIO;
}

// Everything below runs only when this file is the entry point, so importing it
// (to check the arithmetic, or from a future test) neither parses argv nor
// touches a database. Hoisting makes calling `main` before its declaration fine.
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "normalize-standby-count.mjs");
if (isEntryPoint) await main();

async function main() {
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const PROD = argv.includes("--prod");
const toArg = argv.find((a) => a.startsWith("--to="));
const TARGET = toArg ? toArg.slice("--to=".length) : "";

if (TARGET !== "weekly" && TARGET !== "daily") {
  console.error(
    "✗ --to=weekly or --to=daily is required.\n" +
      "  weekly = rolling BACK from a daily pilot (divide by 7) — the usual direction.\n" +
      "  daily  = rolling FORWARD into one (multiply by 7).",
  );
  process.exit(1);
}

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
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

if (PROD) {
  loadEnvFile(resolve(root, ".env"), true);
} else {
  loadEnvFile(resolve(root, ".env.local"), true);
  loadEnvFile(resolve(root, ".env"), false);
}

// Direction guard. The rescale is unconditional arithmetic, so running it in the
// wrong direction — or twice — silently destroys priority instead of restoring
// it: `--to=weekly` over already-weekly data turns 1 and 2 into 0.
//
// `DROP_CADENCE` says which scale the STORED counters are on, because it is what
// the batch was writing them under. So this must run BEFORE the env flip, and
// the value it expects is therefore the OPPOSITE of `--to`. (A dry run against
// production found this: it cheerfully proposed zeroing three healthy weekly
// counters.)
const currentCadence = (process.env.DROP_CADENCE ?? "weekly").trim() || "weekly";
const expectedCadence = TARGET === "weekly" ? "daily" : "weekly";
if (currentCadence !== expectedCadence && !argv.includes("--force")) {
  console.error(
    `✗ Refusing: DROP_CADENCE is "${currentCadence}", so the stored counters are already on the ${currentCadence} scale.\n` +
      `  --to=${TARGET} expects them to be on the ${expectedCadence} scale, i.e. run it BEFORE flipping DROP_CADENCE.\n` +
      `  Running it now would rescale correct data and destroy starvation priority.\n` +
      `  Override with --force only if you know the counters are on the ${expectedCadence} scale despite the env.`,
  );
  process.exit(1);
}

const dbHost = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
console.log(
  `\n▶ standbyCount normalization → ${TARGET}  ` +
    `(${TARGET === "weekly" ? `÷${RATIO}, rounded down` : `×${RATIO}`})`,
);
console.log(`  target DB host: ${dbHost || "(unset)"} ${PROD ? "[--prod]" : "[dev]"}`);
console.log(`  mode: ${APPLY ? "APPLY (writes)" : "dry run (writes nothing)"}\n`);

const { prisma } = await import("@gennety/db");

const rows = await prisma.profile.findMany({
  select: { userId: true, standbyCount: true, missedWeeks: true },
});

if (rows.length === 0) {
  console.log("  No profiles found — nothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

const changes = [];
for (const row of rows) {
  const standby = rescaleStandby(row.standbyCount ?? 0, TARGET);
  const missed = rescaleStandby(row.missedWeeks ?? 0, TARGET);
  if (standby !== (row.standbyCount ?? 0) || missed !== (row.missedWeeks ?? 0)) {
    changes.push({
      userId: row.userId,
      from: { standbyCount: row.standbyCount ?? 0, missedWeeks: row.missedWeeks ?? 0 },
      to: { standbyCount: standby, missedWeeks: missed },
    });
  }
}

// A distribution rather than a per-user dump: the point is to eyeball whether
// the shape is plausible before writing, and a per-user list is unreadable past
// a few dozen accounts.
function distribution(values) {
  const buckets = new Map();
  for (const v of values) buckets.set(v, (buckets.get(v) ?? 0) + 1);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => `${value}×${count}`)
    .join("  ");
}

console.log(`  profiles:        ${rows.length}`);
console.log(`  would change:    ${changes.length}`);
console.log(`  before (standby): ${distribution(rows.map((r) => r.standbyCount ?? 0))}`);
console.log(
  `  after  (standby): ${distribution(rows.map((r) => rescaleStandby(r.standbyCount ?? 0, TARGET)))}`,
);

// The number that actually matters: under weekly, alpha is 0.05 and the cap is
// 0.25, so anything at or above 5 cycles is pinned at the cap and therefore
// indistinguishable from every other capped user.
if (TARGET === "weekly") {
  const cappedBefore = rows.filter((r) => (r.standbyCount ?? 0) >= 5).length;
  const cappedAfter = rows.filter(
    (r) => rescaleStandby(r.standbyCount ?? 0, TARGET) >= 5,
  ).length;
  console.log(
    `\n  at the starvation cap (>=5 weekly cycles): ${cappedBefore} → ${cappedAfter}` +
      (cappedBefore > cappedAfter
        ? `   ← this is the damage the rescale undoes`
        : ""),
  );
}

if (changes.length === 0) {
  console.log("\n  Nothing to change.");
  await prisma.$disconnect();
  process.exit(0);
}

if (!APPLY) {
  console.log("\n  Dry run — nothing written. Re-run with --apply to commit.");
  await prisma.$disconnect();
  process.exit(0);
}

// One transaction: a half-rescaled table is worse than either end state,
// because the two cohorts are then scored on different scales against each
// other.
await prisma.$transaction(
  changes.map((c) =>
    prisma.profile.update({
      where: { userId: c.userId },
      data: { standbyCount: c.to.standbyCount, missedWeeks: c.to.missedWeeks },
    }),
  ),
);

console.log(`\n✓ Updated ${changes.length} profile(s).`);
await prisma.$disconnect();
}
