#!/usr/bin/env node
/**
 * Stuck-match audit (read-only).
 *
 * Diagnoses the "hung date" gap: `proposed` has a 24h TTL (match-expiry.ts) and
 * `scheduled` flips to `completed` at T+24h (date-lifecycle.ts), but the two
 * planning stages in between — `negotiating` (both accepted, picking a calendar
 * slot) and `negotiating_venue` (time locked, choosing a venue) — have NO
 * automatic timeout. A stall there leaves the match live forever, keeps the
 * "My date" menu row up, and (worse) excludes the user from every future weekly
 * batch via the single-live-match invariant (match-engine.ts NOT EXISTS filter).
 *
 * This script only READS. It prints counts, staleness buckets, per-row blocking
 * reasons, and the number of distinct users currently locked out of matching.
 * It never writes anything.
 *
 * Must run under tsx (it imports the TS `@gennety/db` package):
 *   pnpm audit:stuck-matches            # dev DB (.env.local wins)
 *   pnpm audit:stuck-matches --prod     # PRODUCTION (.env only)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const PROD = process.argv.includes("--prod");

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

// --prod: production `.env` only (its DATABASE_URL wins, ignore dev overrides).
// default: dev convention (`.env.local` over `.env`) so an accidental run stays
// on the empty dev DB.
if (PROD) {
  loadEnvFile(resolve(root, ".env"), true);
} else {
  loadEnvFile(resolve(root, ".env.local"), true);
  loadEnvFile(resolve(root, ".env"), false);
}

const dbHost = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
console.log(`\n▶ Stuck-match audit — target DB host: ${dbHost || "(unset)"} ${PROD ? "[--prod]" : "[dev]"}\n`);

const { prisma } = await import("@gennety/db");

const now = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ageDays = (d) => (d ? (now - new Date(d).getTime()) / DAY : null);
const fmtAge = (d) => (d == null ? "—" : `${((now - new Date(d).getTime()) / DAY).toFixed(1)}d`);

const LIVE = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

const matches = await prisma.match.findMany({
  where: { status: { in: LIVE } },
  select: {
    id: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    dispatchedAt: true,
    agreedTime: true,
    venueName: true,
    ticketStatus: true,
    ticketExpiresAt: true,
    acceptedByA: true,
    acceptedByB: true,
    availableTimesA: true,
    availableTimesB: true,
    vibeLatA: true,
    vibeLatB: true,
    parsedCategoryA: true,
    parsedCategoryB: true,
    schedNudge1SentAt: true,
    schedNudge2SentAt: true,
    userAId: true,
    userBId: true,
  },
});

// ── Counts per status ────────────────────────────────────────────────────────
const byStatus = {};
for (const m of matches) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
console.log("Live matches by status:");
for (const s of LIVE) console.log(`  ${s.padEnd(18)} ${byStatus[s] ?? 0}`);
console.log(`  ${"TOTAL".padEnd(18)} ${matches.length}\n`);

// ── The two stages without a TTL ─────────────────────────────────────────────
const planning = matches.filter(
  (m) => m.status === "negotiating" || m.status === "negotiating_venue",
);

function blockingReason(m) {
  if (m.status === "negotiating") {
    const ticketOpen = ["pending", "partial", "refund_pending"].includes(m.ticketStatus ?? "");
    if (ticketOpen) return `ticket gate (${m.ticketStatus})`;
    const aPicked = (m.availableTimesA?.length ?? 0) > 0;
    const bPicked = (m.availableTimesB?.length ?? 0) > 0;
    if (!aPicked && !bPicked) return "calendar: neither side picked";
    if (!aPicked) return "calendar: side A hasn't picked";
    if (!bPicked) return "calendar: side B hasn't picked";
    return "calendar: picks made, no overlap yet";
  }
  // negotiating_venue
  const missing = [];
  if (m.vibeLatA == null) missing.push("A departure");
  if (m.vibeLatB == null) missing.push("B departure");
  if (m.parsedCategoryA == null) missing.push("A vibe");
  if (m.parsedCategoryB == null) missing.push("B vibe");
  if (missing.length === 0) return "all inputs present, venue not finalized";
  return `venue: missing ${missing.join(", ")}`;
}

// Staleness buckets by time since last activity (updatedAt).
const buckets = { "<1d": [], "1-3d": [], "3-7d": [], ">7d": [] };
for (const m of planning) {
  const a = ageDays(m.updatedAt) ?? 0;
  const key = a < 1 ? "<1d" : a < 3 ? "1-3d" : a < 7 ? "3-7d" : ">7d";
  buckets[key].push(m);
}

console.log("Planning-stage matches (no TTL) by staleness (since last update):");
for (const [k, arr] of Object.entries(buckets)) {
  console.log(`  ${k.padEnd(6)} ${arr.length}`);
}
console.log();

// Genuinely stuck = no activity for >3 days.
const stuck = [...buckets["3-7d"], ...buckets[">7d"]].sort(
  (a, b) => new Date(a.updatedAt) - new Date(b.updatedAt),
);

if (stuck.length) {
  console.log(`⚠  ${stuck.length} planning match(es) idle >3 days — likely hung:\n`);
  console.log(
    `  ${"match".padEnd(10)} ${"status".padEnd(18)} ${"idle".padEnd(7)} ${"created".padEnd(8)} blocking`,
  );
  for (const m of stuck) {
    console.log(
      `  ${m.id.slice(0, 8).padEnd(10)} ${m.status.padEnd(18)} ${fmtAge(m.updatedAt).padEnd(7)} ${fmtAge(m.createdAt).padEnd(8)} ${blockingReason(m)}`,
    );
  }
  console.log();
} else {
  console.log("✓ No planning matches idle >3 days.\n");
}

// ── The real harm: users locked out of the weekly batch ──────────────────────
const lockedAll = new Set();
const lockedStuck = new Set();
for (const m of planning) {
  lockedAll.add(m.userAId);
  lockedAll.add(m.userBId);
}
for (const m of stuck) {
  lockedStuck.add(m.userAId);
  lockedStuck.add(m.userBId);
}
console.log("Users excluded from future weekly batches by a planning-stage match:");
console.log(`  in any negotiating / negotiating_venue : ${lockedAll.size}`);
console.log(`  in a >3d-idle (hung) one               : ${lockedStuck.size}\n`);

// ── Sanity checks on the stages that DO have a TTL ───────────────────────────
const staleProposed = matches.filter(
  (m) => m.status === "proposed" && ageDays(m.dispatchedAt ?? m.createdAt) > 1.05,
);
const staleScheduled = matches.filter(
  (m) => m.status === "scheduled" && m.agreedTime && new Date(m.agreedTime).getTime() + DAY < now,
);
console.log("Sanity (should be ~0 if the crons are running):");
console.log(`  proposed older than 24h (expiry cron?)          : ${staleProposed.length}`);
console.log(`  scheduled past agreedTime+24h (lifecycle tick?) : ${staleScheduled.length}\n`);

await prisma.$disconnect();
