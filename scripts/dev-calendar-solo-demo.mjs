#!/usr/bin/env node
/**
 * Dev-only helper (local @gennetytestbot + localhost dev DB only).
 *
 * Sets up a one-person calendar review: creates a `negotiating` match between
 * a REAL test account (A, the human tester) and a stand-in partner (B), runs
 * the real `startScheduling` (writes the 36-slot grid + DMs the Calendar
 * button to both sides), then SEEDS a few of B's availability slots so that
 * when A opens the Calendar Mini App they immediately see the partner's marks
 * (the burgundy / --brand-light "peer" slots) and can create overlaps — the
 * exact dark-theme states the colour fix touches, without a second live human.
 *
 * Unlike dev-trigger-scheduling this calls createProposedMatch WITHOUT a score
 * breakdown (the real scorer now needs an agePref field that the older helper
 * didn't pass, which NaN'd the score-log insert). No scoring is needed to view
 * the calendar.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-calendar-solo-demo.mjs --a=<tester tg> --b=<partner tg>
 *
 * Both accounts must already exist and be match-ready — run
 * dev-prep-calendar-accounts.mjs first. Only A needs to be a Telegram account
 * the human can open; B is a stand-in and its DM can be ignored.
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

function createTelegramApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, payload) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const description = json?.description ?? `${res.status} ${res.statusText}`;
      const err = new Error(`Telegram ${method} failed: ${description}`);
      err.telegram = true;
      throw err;
    }
    return json.result;
  }
  return {
    sendMessage: (chatId, text, options = {}) =>
      call("sendMessage", { chat_id: chatId, text, ...options }),
    editMessageText: (chatId, messageId, text, options = {}) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options }),
    deleteMessage: (chatId, messageId) =>
      call("deleteMessage", { chat_id: chatId, message_id: messageId }),
  };
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Pass --force to override.");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  const { prisma } = await import("@gennety/db");
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { startScheduling } = await import("../apps/bot/src/handlers/matching/scheduler.js");
  const api = createTelegramApi(process.env.BOT_TOKEN);

  const A = await prisma.user.findUnique({ where: { telegramId: aTg }, select: { id: true, firstName: true, profile: { select: { homeCityKey: true } } } });
  const B = await prisma.user.findUnique({ where: { telegramId: bTg }, select: { id: true, firstName: true, profile: { select: { homeCityKey: true } } } });
  if (!A) throw new Error(`Tester A (tg=${aTg}) not found — run dev-prep-calendar-accounts.mjs first.`);
  if (!B) throw new Error(`Partner B (tg=${bTg}) not found — run dev-prep-calendar-accounts.mjs first.`);

  // Cancel any stale in-flight matches so createProposedMatch's cooldown and the
  // one-live-card invariants don't collide with an old row.
  const stale = await prisma.match.findMany({
    where: { status: { in: OPEN_STATUSES }, OR: [{ userAId: { in: [A.id, B.id] } }, { userBId: { in: [A.id, B.id] } }] },
    select: { id: true },
  });
  if (stale.length) {
    await prisma.match.updateMany({ where: { id: { in: stale.map((m) => m.id) } }, data: { status: "cancelled" } });
    console.log(`Cancelled ${stale.length} stale in-flight match(es).`);
  }
  // createProposedMatch bumps lastMatchedAt (24h cooldown); clear it so a
  // repeated demo run isn't blocked (the engine only reads it in the batch SQL,
  // but keep the accounts clean for re-runs).
  await prisma.profile.updateMany({ where: { userId: { in: [A.id, B.id] } }, data: { lastMatchedAt: null } });

  // 1. Clean proposed match (no score breakdown — scoring isn't needed here).
  const match = await createProposedMatch(A.id, B.id);
  const matchId = match.id;

  // 2. Land straight on the calendar: mutual accept, status=negotiating.
  await prisma.match.update({
    where: { id: matchId },
    data: { acceptedByA: true, acceptedByB: true, status: "negotiating", dispatchedAt: new Date() },
  });

  // 3. Real scheduling handoff: writes the 36-slot grid + DMs the Calendar
  //    button to both sides. Report per-side send outcome (A must succeed).
  let sendError = null;
  try {
    await startScheduling(api, matchId);
  } catch (err) {
    sendError = err;
  }

  // 4. Seed the partner's (B) marks so A sees peer-only slots the moment they
  //    open. Spread across different days; A can tap one to make an overlap.
  const fresh = await prisma.match.findUnique({ where: { id: matchId }, select: { proposedTimes: true } });
  const slots = fresh?.proposedTimes ?? [];
  const pick = [1, 8, 20].filter((i) => i < slots.length).map((i) => slots[i]);
  await prisma.match.update({ where: { id: matchId }, data: { availableTimesB: pick } });

  console.log("\n── RESULT ──");
  console.log(JSON.stringify({
    matchId,
    tester: { tg: aTg.toString(), name: A.firstName, city: A.profile?.homeCityKey },
    partner: { tg: bTg.toString(), name: B.firstName, city: B.profile?.homeCityKey },
    proposedSlots: slots.length,
    seededPeerMarks: pick.map((d) => new Date(d).toISOString()),
    calendarButtonSent: sendError ? `PARTIAL/FAILED: ${sendError.message}` : "sent to both sides",
  }, null, 2));

  if (sendError) {
    console.log(
      "\n⚠️  A calendar-button DM failed. If it says 'chat not found' / 'bot can't initiate' " +
      "for the tester, that account has not messaged @gennetytestbot yet — open " +
      "https://t.me/gennetytestbot from it and press Start, then re-run.",
    );
  } else {
    console.log("\n✅ Open the 'Open Calendar' button on the tester account. You'll see the partner's");
    console.log("   burgundy (light-tone) marks already on the grid; add your own to see mine/overlap.");
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("SOLO-DEMO FAILED:", err.message);
  process.exit(1);
});
