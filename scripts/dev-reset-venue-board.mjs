#!/usr/bin/env node
/**
 * Dev-only helper (local dev bot only).
 *
 * Resets the venue-change board (§3.7b) on the pair's current `scheduled`
 * match back to a clean, open session: no likes, no initiator, no agreement,
 * no payment stamps. The date, the pair and the originally-assigned venue are
 * left alone, so you can walk the board flow again from scratch.
 *
 * Handy because a settled change closes the board for good (one paid change
 * per date) — this is how you replay the next scenario.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-reset-venue-board.mjs
 * Optional:
 *   --restore-venue   also re-point the match at the ORIGINAL assigned venue
 *                     (undo a settled swap). Needs --original-name/-address to
 *                     be meaningful; by default a settled venue simply stays.
 *   --force           bypass the gennetytestbot / dev-DB guards
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const args = new Set(process.argv.slice(2));
const force = args.has("--force");

if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
  throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot).");
}
if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
  throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
}

const { prisma } = await import("@gennety/db");

const match = await prisma.match.findFirst({
  where: { status: "scheduled" },
  orderBy: { createdAt: "desc" },
  select: { id: true, venueName: true, venueChangeStatus: true },
});
if (!match) throw new Error("No `scheduled` match found. Run dev-continue-date --stop-at=scheduled first.");

await prisma.match.update({
  where: { id: match.id },
  data: {
    venueChangeStatus: null,
    venueChangeProposerId: null,
    venueChangeProposedAt: null,
    venueChangeExpiresAt: null,
    venueChangeResolvedAt: null,
    venueChangeName: null,
    venueChangeAddress: null,
    venueChangeLat: null,
    venueChangeLng: null,
    venueChangeMapsUri: null,
    venueChangePlaceId: null,
    venueChangePhotoUrl: null,
    venueChangePhotoName: null,
    venueChangePaidById: null,
    venueChangePaidAt: null,
    venueChangePayDeclinedAt: null,
    venueChangeOfferPaySentAt: null,
    venueChangePingSentToAAt: null,
    venueChangePingSentToBAt: null,
    venueChangeExpressAt: null,
    venueLikesA: [],
    venueLikesB: [],
  },
});

console.log(
  `Venue board reset on match ${match.id} ` +
    `(was: ${match.venueChangeStatus ?? "none"}). Current venue: ${match.venueName}`,
);
await prisma.$disconnect();
