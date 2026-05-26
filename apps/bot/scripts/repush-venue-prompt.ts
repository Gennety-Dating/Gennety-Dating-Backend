/**
 * Re-send the concierge venue prompt to both users in a `negotiating_venue`
 * match. Used after the bot's prompt template / keyboard changes — the
 * canonical prompt is sent once on entry to `negotiating_venue` and not
 * resent automatically, so an in-flight match keeps the old keyboard.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/repush-venue-prompt.ts <matchId>
 *
 * Side effects:
 *   - Reads match + both user sides via Prisma.
 *   - Sends the venue concierge intro + the Mini App `web_app` button
 *     (same keyboard `startVenueNegotiation` would build) to whichever
 *     side(s) are Telegram-resident.
 *   - Does NOT touch match status or any DB column. Pure dispatch.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { Api } = await import("grammy");
const { prisma } = await import("@gennety/db");
const { t } = await import("@gennety/shared");
const { buildLocationMapKeyboard } = await import(
  "../src/handlers/matching/venue-negotiation.js"
);

async function main(): Promise<void> {
  const [matchId] = process.argv.slice(2);
  if (!matchId) {
    console.error("Usage: tsx scripts/repush-venue-prompt.ts <matchId>");
    process.exit(1);
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    console.error("BOT_TOKEN missing from .env.local — did the dev env load?");
    process.exit(1);
  }
  const api = new Api(botToken);
  const me = await api.getMe();
  if (me.username && me.username !== "gennetytestbot") {
    console.error(
      `Refusing to dispatch: connected bot is @${me.username}, expected @gennetytestbot.`,
    );
    process.exit(2);
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      userA: { select: { telegramId: true, language: true, firstName: true } },
      userB: { select: { telegramId: true, language: true, firstName: true } },
    },
  });
  if (!match) {
    console.error(`No match ${matchId}`);
    process.exit(3);
  }
  if (match.status !== "negotiating_venue") {
    console.error(
      `Match is in status=${match.status}, expected 'negotiating_venue'. ` +
        "Re-pushing the venue prompt only makes sense in that state.",
    );
    process.exit(4);
  }

  const langA = (match.userA.language ?? "en") as Parameters<typeof t>[0];
  const langB = (match.userB.language ?? "en") as Parameters<typeof t>[0];

  const sends: Array<Promise<unknown>> = [];
  if (match.userA.telegramId > 0n) {
    sends.push(
      api.sendMessage(Number(match.userA.telegramId), t(langA, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationMapKeyboard(matchId, langA),
      }),
    );
  }
  if (match.userB.telegramId > 0n) {
    sends.push(
      api.sendMessage(Number(match.userB.telegramId), t(langB, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationMapKeyboard(matchId, langB),
      }),
    );
  }
  await Promise.all(sends);

  console.log(`Re-pushed venue prompt to ${sends.length} user(s) for match ${matchId}.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    void prisma.$disconnect();
    process.exit(1);
  });
