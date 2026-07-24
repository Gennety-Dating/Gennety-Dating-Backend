/**
 * Dev-only: roll a live match (typically `scheduled`, but any of
 * scheduled/negotiating_venue/negotiating/proposed) BACK to a clean
 * `negotiating_venue` step so the Venue Intent V2 two-step Mini App flow can be
 * re-tested end-to-end. Because two users who already matched can never be
 * re-paired (lifetime-ban invariant §3.2), re-testing venue selection means
 * reusing the existing match — this is that reset.
 *
 * With --apply it:
 *   - sets status = negotiating_venue and bumps agreedTime to +3 days at 18:00
 *     Kyiv (a clean future slot, so a re-finalized date lands comfortably ahead
 *     and the date-lifecycle worker doesn't fire icebreakers/emergency on a
 *     past time);
 *   - clears every venue INPUT (vibe text / parsed category / departure pin /
 *     vibeAddress / venueIntent{A,B}) and venue RESULT (venueName/Address/
 *     Lat/Lng/GoogleMapsUri/PhotoUrl/PhotoName) field;
 *   - clears the cached date-card file ids + the post-schedule lifecycle stamps
 *     (icebreakers / safety / wingman) so the My Date hub shows a clean plan;
 *   - re-DMs both Telegram sides the concierge intro + "Pick on map" button.
 * It does NOT touch the accept decision or tickets.
 *
 * Guarded to the dev DB + a non-empty bypass list — NOT a production path.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reset-to-venue-step.ts
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reset-to-venue-step.ts --match=<id>
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reset-to-venue-step.ts --apply
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

if (
  process.env.BOT_USERNAME !== "gennetytestbot" ||
  !process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev")
) {
  throw new Error(
    "Refusing to run: expected BOT_USERNAME=gennetytestbot and the local localhost:5434/gennety_dev database.",
  );
}
if (!(process.env.DEV_OTP_BYPASS_TELEGRAM_IDS ?? "").trim()) {
  throw new Error(
    "Refusing to run: DEV_OTP_BYPASS_TELEGRAM_IDS must be non-empty (dev-only guard).",
  );
}

const apply = process.argv.includes("--apply");
const matchArg = process.argv.find((a) => a.startsWith("--match="));

const { prisma } = await import("@gennety/db");
const { Bot } = await import("grammy");
const { t } = await import("@gennety/shared");
const { buildLocationMapKeyboard } = await import(
  "../../src/handlers/matching/venue-negotiation.js"
);
const { venueIntentMode } = await import(
  "../../src/services/venue-intent-v2.js"
);

const LIVE_STATUSES = ["scheduled", "negotiating_venue", "negotiating", "proposed"] as const;

const match = matchArg
  ? await prisma.match.findUnique({
      where: { id: matchArg.slice("--match=".length) },
      include: { userA: true, userB: true },
    })
  : await prisma.match.findFirst({
      where: { status: { in: [...LIVE_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      include: { userA: true, userB: true },
    });

if (!match) {
  console.error("No live match found (pass --match=<id>).");
  process.exit(1);
}

const mode = venueIntentMode(match.id);
console.log(
  `match=${match.id.slice(0, 8)} status=${match.status} venueIntentMode="${mode}"`,
);
console.log(
  `  A=${match.userA.firstName ?? "?"} (tg=${match.userA.telegramId}) lang=${match.userA.language}`,
);
console.log(
  `  B=${match.userB.firstName ?? "?"} (tg=${match.userB.telegramId}) lang=${match.userB.language}`,
);
if (mode !== "live") {
  console.warn(
    `  ⚠ mode is "${mode}", not "live" — check VENUE_INTENT_V2_ENABLED / _ROLLOUT_PERCENT in .env.local.`,
  );
}

// A clean future slot: +3 days at 18:00 Europe/Kyiv (≈ 15:00 UTC in summer).
const agreed = new Date();
agreed.setUTCDate(agreed.getUTCDate() + 3);
agreed.setUTCHours(15, 0, 0, 0);

if (!apply) {
  console.log(
    `\nDry-run. Re-run with --apply to roll this match back to a clean negotiating_venue step (agreedTime → ${agreed.toISOString()}) and re-DM both sides.`,
  );
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.match.update({
  where: { id: match.id },
  data: {
    status: "negotiating_venue",
    agreedTime: agreed,
    // Venue inputs
    vibeTextA: null,
    vibeTextB: null,
    parsedCategoryA: null,
    parsedCategoryB: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeLatB: null,
    vibeLngB: null,
    vibeAddressA: null,
    vibeAddressB: null,
    venueIntentA: null,
    venueIntentB: null,
    venuePromptAskedAt: new Date(),
    // Venue results
    venueName: null,
    venueAddress: null,
    venueLat: null,
    venueLng: null,
    venueGoogleMapsUri: null,
    venuePhotoUrl: null,
    venuePhotoName: null,
    // Cached date card + post-schedule lifecycle stamps
    dateCardFileIdA: null,
    dateCardFileIdB: null,
    icebreakersSentAt: null,
    iceBreakersA: [],
    iceBreakersB: [],
    safetyNoteSentAt: null,
    wingmanSentAt: null,
  },
});
console.log(`rolled match ${match.id.slice(0, 8)} → negotiating_venue (agreedTime ${agreed.toISOString()}), venue in/out cleared.`);

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN missing.");
const api = new Bot(token).api;

for (const [side, u] of [
  ["A", match.userA],
  ["B", match.userB],
] as const) {
  if (u.telegramId <= 0n) {
    console.log(`  ${side}: synthetic telegramId ${u.telegramId} (mobile) — skipped.`);
    continue;
  }
  const lang = (u.language ?? "en") as Parameters<typeof t>[0];
  await api.sendMessage(Number(u.telegramId), t(lang, "venueConciergeIntro"), {
    parse_mode: "Markdown",
    reply_markup: buildLocationMapKeyboard(match.id, lang, u.theme),
  });
  console.log(`  ${side}: re-DMed venueConciergeIntro + map button (lang=${lang}).`);
}

console.log(
  `\n✅ Match ${match.id.slice(0, 8)} is at a clean V2 venue step. Both sides can tap "Pick on map" → new two-step Mini App flow.`,
);
await prisma.$disconnect();
