#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot + localhost dev DB only).
 *
 * Sets up the Venue-Change board (PRODUCT_SPEC §3.7b) for a design pass and
 * DMs the tester TWO "Change venue" buttons pointing at the SAME match — one
 * that opens the Mini App in DARK theme, one in LIGHT theme (via the documented
 * `?theme=` deep-link override honoured by each *.html boot snippet). This lets
 * a single connected account (@GGen1e) review both themes side-by-side without a
 * second live Telegram account.
 *
 * It creates a `scheduled` match between a real tester (A) and a stand-in
 * partner (B), locks an `agreedTime` a few days out (so it's before the
 * board's T-5h cutoff), and sets a real central-Kyiv venue so the board's
 * 3 km "alternatives" catalog (curated-first, Places fallback) returns real
 * nearby spots to heart. `venueChangeStatus` is left null → board opens.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-venue-change-demo.mjs --a=<tester tg> --b=<partner tg>
 *
 * Both accounts must already exist (run dev-prep-calendar-accounts.mjs first);
 * only A needs to be a Telegram account the human can open.
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
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

const force = args.get("force") === "true";
const aTg = BigInt(args.get("a") ?? "782065541");
const bTg = BigInt(args.get("b") ?? "5986970093");

const OPEN_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

// Real central-Kyiv venue so the 3km alternatives catalog (Places fallback with
// the local PLACES_API_KEY) returns genuine nearby cafes/restaurants to heart.
const VENUE = {
  venueName: "Aroma Kava",
  venueAddress: "vulytsia Khreshchatyk 15, Kyiv",
  venueLat: 50.4472,
  venueLng: 30.5219,
  venueGoogleMapsUri: "https://maps.google.com/?q=50.4472,30.5219",
};

async function tgCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description ?? `${res.status} ${res.statusText}`}`);
  }
  return json.result;
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Pass --force to override.");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");
  const webappUrl = process.env.WEBAPP_URL;
  if (!webappUrl?.startsWith("https://")) {
    throw new Error(`WEBAPP_URL must be an https tunnel for web_app buttons; got: ${webappUrl}`);
  }
  if (process.env.VENUE_CHANGE_FEATURE_ENABLED !== "true") {
    console.warn("⚠️  VENUE_CHANGE_FEATURE_ENABLED is not 'true' — the board will render closedReason=feature-disabled.");
  }

  const { prisma } = await import("@gennety/db");
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const token = process.env.BOT_TOKEN;

  const A = await prisma.user.findUnique({ where: { telegramId: aTg }, select: { id: true, firstName: true, gender: true } });
  const B = await prisma.user.findUnique({ where: { telegramId: bTg }, select: { id: true, firstName: true, gender: true } });
  if (!A) throw new Error(`Tester A (tg=${aTg}) not found — run dev-prep-calendar-accounts.mjs first.`);
  if (!B) throw new Error(`Partner B (tg=${bTg}) not found — run dev-prep-calendar-accounts.mjs first.`);

  // Hetero pair (A female, B male) so the full payer matrix / express states are
  // reachable when the tester hearts a place and reaches an agreement.
  if (!A.gender) await prisma.user.update({ where: { id: A.id }, data: { gender: "female" } });
  if (!B.gender) await prisma.user.update({ where: { id: B.id }, data: { gender: "male" } });

  // Clear stale in-flight rows + cooldown so re-runs are clean.
  const stale = await prisma.match.findMany({
    where: { status: { in: OPEN_STATUSES }, OR: [{ userAId: { in: [A.id, B.id] } }, { userBId: { in: [A.id, B.id] } }] },
    select: { id: true },
  });
  if (stale.length) {
    await prisma.match.updateMany({ where: { id: { in: stale.map((m) => m.id) } }, data: { status: "cancelled" } });
    console.log(`Cancelled ${stale.length} stale in-flight match(es).`);
  }
  await prisma.profile.updateMany({ where: { userId: { in: [A.id, B.id] } }, data: { lastMatchedAt: null } });

  // 1. Proposed match (no score breakdown — scoring isn't needed to view a board).
  const match = await createProposedMatch(A.id, B.id);
  const matchId = match.id;

  // 2. Jump straight to a scheduled date with a locked venue, board still open.
  const agreedTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3 days (> T-5h cutoff)
  await prisma.match.update({
    where: { id: matchId },
    data: {
      acceptedByA: true,
      acceptedByB: true,
      status: "scheduled",
      dispatchedAt: new Date(),
      agreedTime,
      venueChangeStatus: null,
      ...VENUE,
    },
  });

  // 3. DM each account its own button for the SAME match — so both sides can
  //    open the board simultaneously and watch each other's likes land live
  //    (~4s polling). Account A = DARK theme, account B = LIGHT theme, so the
  //    two themes are compared across the two real participants.
  const url = (theme) => `${webappUrl}/venue-change.html?match=${matchId}&lang=en&theme=${theme}`;
  async function dmButton(chatId, who, theme) {
    try {
      const sent = await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text:
          "🎨 Venue-change board (design pass)\n\n" +
          `Locked venue: ${VENUE.venueName} — ${VENUE.venueAddress}\n` +
          `Theme: ${theme.toUpperCase()}. Open it, heart a few places — your ` +
          "partner (the other account) sees your hearts live within ~4s.",
        reply_markup: {
          inline_keyboard: [[{ text: `${theme === "dark" ? "🌙" : "☀️"} Change venue · ${theme.toUpperCase()}`, web_app: { url: url(theme) } }]],
        },
      });
      return { who, chatId, theme, messageId: sent.message_id };
    } catch (err) {
      return { who, chatId, theme, error: err.message };
    }
  }

  const dmA = await dmButton(aTg.toString(), A.firstName, "dark");
  const dmB = await dmButton(bTg.toString(), B.firstName, "light");

  console.log("\n── RESULT ──");
  console.log(JSON.stringify({
    matchId,
    venue: VENUE.venueName,
    agreedTime: agreedTime.toISOString(),
    accountA: dmA,
    accountB: dmB,
  }, null, 2));
  if (dmA.error) console.log(`\n⚠️  Could not DM ${A.firstName} (${aTg}): ${dmA.error}`);
  if (dmB.error) {
    console.log(
      `\n⚠️  Could not DM ${B.firstName} (${bTg}): ${dmB.error}\n` +
      "   That account must press Start on @gennetytestbot once before the bot can DM it.",
    );
  }
  if (!dmA.error && !dmB.error) {
    console.log("\n✅ Board sent to BOTH accounts. Open them side-by-side: heart a place on one,");
    console.log("   watch it appear as a partner-like on the other. A=DARK, B=LIGHT.");
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("VENUE-CHANGE-DEMO FAILED:", err.message);
  process.exit(1);
});
