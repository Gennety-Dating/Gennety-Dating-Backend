#!/usr/bin/env node
/**
 * Dev-only helper (local DEP bot only).
 *
 * Triggers a match between the two local test accounts and drops them straight
 * into the standard time/venue selection cycle, SKIPPING the parts that need a
 * live user tap or a paid service step:
 *
 *   1. createProposedMatch(A, B)            → real match row + score log
 *   2. record mutual accept in the DB        → acceptedByA/B = true, status = negotiating
 *      (no Accept/Decline taps, no Elo mutation, no ticket gate)
 *   3. startScheduling(api, matchId)         → real 30-slot grid + "Open Calendar"
 *                                              button DM'd to both sides
 *
 * Then it STOPS. Both users pick their time on the real Calendar Mini App and
 * provide vibe + commute origin exactly as in production; this script does not
 * touch the calendar/venue/lifecycle code.
 *
 * Why a dedicated script: `dev:e2e-full-flow` refuses to run with
 * TICKET_FEATURE_ENABLED=true AND auto-drives the calendar/venue itself, which
 * is the opposite of "let the humans pick the time and place".
 *
 * Usage:
 *   node scripts/dev-trigger-scheduling.mjs
 *
 * Optional:
 *   --primary-tg=782065541 --secondary-tg=7778727321
 *   --keep-open   do NOT cancel existing in-flight matches first
 *   --force       bypass the gennetytestbot / dev-DB guards
 *
 * Safe to run while `pnpm dev:bot` is up — Telegram long-polling is owned by
 * the bot process; this only issues Bot API HTTP calls.
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

// Load local dev env before importing anything that constructs Prisma.
loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const OPEN_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

const force = args.get("force") === "true";
const keepOpen = args.get("keep-open") === "true";
const primaryTg = BigInt(args.get("primary-tg") ?? "782065541");
const secondaryTg = BigInt(args.get("secondary-tg") ?? "7778727321");

let prisma;

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
      throw new Error(`Telegram ${method} failed: ${description}`);
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

async function loadUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true, telegramId: true, firstName: true, status: true,
      onboardingStep: true, isEmailVerified: true, universityDomain: true,
      gender: true, preference: true, language: true,
      profile: { select: { homeCityKey: true, latitude: true, longitude: true } },
    },
  });
}

function assertReady(label, u) {
  if (!u) throw new Error(`${label} not found — run /start + onboarding first.`);
  if (u.status !== "active") throw new Error(`${label} status=${u.status}, expected active.`);
  if (u.onboardingStep !== "completed") throw new Error(`${label} onboardingStep=${u.onboardingStep}, expected completed.`);
  if (!u.isEmailVerified || !u.universityDomain) throw new Error(`${label} missing verified email/domain.`);
  if (!u.gender || !u.preference) throw new Error(`${label} missing gender/preference.`);
  if (!u.profile?.homeCityKey || u.profile.latitude === null || u.profile.longitude === null) {
    throw new Error(`${label} missing dating city/coordinates.`);
  }
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot. Expected BOT_USERNAME=gennetytestbot (pass --force to override).");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  const db = await import("@gennety/db");
  prisma = db.prisma;
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { startScheduling } = await import("../apps/bot/src/handlers/matching/scheduler.js");

  const api = createTelegramApi(process.env.BOT_TOKEN);

  const primary = await loadUser(primaryTg);
  const secondary = await loadUser(secondaryTg);
  assertReady("Primary (A)", primary);
  assertReady("Secondary (B)", secondary);
  if (primary.profile.homeCityKey !== secondary.profile.homeCityKey) {
    throw new Error(`Dating cities differ: ${primary.profile.homeCityKey} vs ${secondary.profile.homeCityKey}.`);
  }

  console.log(JSON.stringify({
    bot: process.env.BOT_USERNAME,
    A: { tg: primary.telegramId.toString(), name: primary.firstName, gender: primary.gender, city: primary.profile.homeCityKey },
    B: { tg: secondary.telegramId.toString(), name: secondary.firstName, gender: secondary.gender, city: secondary.profile.homeCityKey },
  }, null, 2));

  // ── 0. Clean up stale in-flight matches between these two ─────────────
  if (!keepOpen) {
    const open = await prisma.match.findMany({
      where: {
        status: { in: OPEN_STATUSES },
        OR: [
          { userAId: { in: [primary.id, secondary.id] } },
          { userBId: { in: [primary.id, secondary.id] } },
        ],
      },
      select: { id: true },
    });
    if (open.length > 0) {
      await prisma.match.updateMany({ where: { id: { in: open.map((m) => m.id) } }, data: { status: "cancelled" } });
      console.log(`[0] Cancelled ${open.length} stale in-flight match(es).`);
    }
  }

  // ── 1. Create the proposed match (real engine + score log) ────────────
  const match = await createProposedMatch(primary.id, secondary.id, {
    explicit: 0.88, research: 0.78, league: 1, penalty: 0, embeddingDistance: 0.24, starvationBonus: 0,
  });
  const matchId = match.id;
  console.log(`[1] createProposedMatch → matchId=${matchId} status=${match.status}`);

  // ── 2. Record mutual accept WITHOUT the decision contest ──────────────
  // Mirrors the end-state of decision.ts mutual-accept (acceptedByA/B=true,
  // status=negotiating) but deliberately skips the Accept/Decline taps, the
  // Elo mutation, and the ticket gate so we land straight on the calendar.
  await prisma.match.update({
    where: { id: matchId },
    data: {
      acceptedByA: true,
      acceptedByB: true,
      status: "negotiating",
      dispatchedAt: new Date(),
    },
  });
  console.log(`[2] Recorded mutual accept → status=negotiating (Accept/Decline + ticket gate bypassed)`);

  // ── 3. Real scheduling handoff: slot grid + Calendar button DMs ───────
  await startScheduling(api, matchId);
  console.log(`[3] startScheduling → slot grid written + Calendar button DM'd to both sides`);

  const final = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true, acceptedByA: true, acceptedByB: true,
      proposedTimes: true, agreedTime: true,
      calendarMessageIdA: true, calendarMessageIdB: true,
    },
  });
  console.log("\n── RESULT ──");
  console.log(JSON.stringify({
    matchId,
    status: final.status,
    accepted: { A: final.acceptedByA, B: final.acceptedByB },
    proposedSlots: final.proposedTimes.length,
    agreedTime: final.agreedTime?.toISOString() ?? null,
    calendarCardSent: { A: final.calendarMessageIdA !== null, B: final.calendarMessageIdB !== null },
  }, null, 2));
  console.log("\nBoth accounts now have the 'Open Calendar' button. Pick a time, then vibe + commute origin — the real scheduling/venue cycle runs from here.");
}

main()
  .finally(async () => { await prisma?.$disconnect(); })
  .catch((err) => {
    console.error("\nTRIGGER FAILED:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
