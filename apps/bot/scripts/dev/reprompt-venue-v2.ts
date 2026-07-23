/**
 * Dev-only: reset the venue-negotiation step of a live `negotiating_venue`
 * match and re-DM both Telegram sides the concierge intro + "Pick on map"
 * button, so a match that already partially ran the OLD venue flow can be
 * re-tested cleanly under Venue Intent V2 (`VENUE_INTENT_V2_ENABLED=true` +
 * `VENUE_INTENT_V2_ROLLOUT_PERCENT=100`).
 *
 * It clears ONLY the participant venue inputs + any stored V2 intent
 * (vibe text / parsed category / departure pin / venueIntent{A,B}); it does
 * NOT touch match status, agreedTime, tickets, or the accept decision — the
 * match stays `negotiating_venue`, the calendar/ticket work is preserved.
 * `startVenueNegotiation`'s own re-DM is guarded on `status="negotiating"`,
 * so it can't re-prompt a match already at `negotiating_venue`; this script
 * sends the identical intro directly instead.
 *
 * Guarded to the dev DB + a non-empty bypass list — NOT a production path.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reprompt-venue-v2.ts
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reprompt-venue-v2.ts --match=<id>
 *   pnpm --filter @gennety/bot exec tsx scripts/dev/reprompt-venue-v2.ts --apply
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

const match = matchArg
  ? await prisma.match.findUnique({
      where: { id: matchArg.slice("--match=".length) },
      include: { userA: true, userB: true },
    })
  : await prisma.match.findFirst({
      where: { status: "negotiating_venue" },
      orderBy: { updatedAt: "desc" },
      include: { userA: true, userB: true },
    });

if (!match) {
  console.error("No negotiating_venue match found (pass --match=<id>).");
  process.exit(1);
}
if (match.status !== "negotiating_venue") {
  console.error(`Match ${match.id} is '${match.status}', not negotiating_venue.`);
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

if (!apply) {
  console.log(
    "\nDry-run. Re-run with --apply to clear the venue inputs and re-DM both sides the V2 concierge intro.",
  );
  await prisma.$disconnect();
  process.exit(0);
}

// 1) Clear participant venue inputs + any stored V2 intent (status/agreedTime
//    /tickets untouched). Result columns are already null (no finalization ran).
await prisma.match.update({
  where: { id: match.id },
  data: {
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
  },
});
console.log("cleared venue inputs (vibe/pin/intent) for both sides.");

// 2) Re-DM both Telegram sides the concierge intro + Pick-on-map button.
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
  `\n✅ Match ${match.id.slice(0, 8)} reset to a clean V2 venue step. Both sides can now tap "Pick on map" for the two-step chip flow.`,
);
await prisma.$disconnect();
