#!/usr/bin/env node
/**
 * Dev-only helper (local DEP bot only).
 *
 * Continues the CURRENT in-flight match between the two test accounts all the
 * way through the date, firing every real "accompanying" lifecycle message so
 * you can see them in Telegram. Ticket-gate aware (works with
 * TICKET_FEATURE_ENABLED=true by bypassing the gate, unlike dev:e2e-full-flow).
 *
 * Stages (each idempotent — safe to re-run; skips stages already done):
 *   1. proposed → negotiating   : record mutual accept, bypass the ticket gate,
 *                                  run real startScheduling (writes slot grid).
 *   2. negotiating → venue      : auto-pick a single overlapping calendar slot
 *                                  (processCalendarSlotsUpdate) → agreedTime.
 *   3. venue → scheduled        : auto vibe + commute origin both sides
 *                                  (handleVenueVibe / handleVenueLocation) →
 *                                  tryFinalize → real Places venue → scheduled.
 *   4. lifecycle ticks          : runDateLifecycleTick with crafted `now` at
 *                                  T-5h (ice-breakers + emergency window),
 *                                  T-1.5h (female safety brief + wingman reveal),
 *                                  T-1h (coordination offer), T-30m (proxy open),
 *                                  T+24h (feedback prompt → completed).
 *
 * Does NOT auto-submit feedback — the T+24h prompt lands and you reply for real.
 *
 * Usage:
 *   node scripts/dev-continue-date.mjs
 * Optional:
 *   --primary-tg=782065541 --secondary-tg=7778727321
 *   --force   bypass the gennetytestbot / dev-DB guards
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

const OPEN_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

const args = new Map(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.slice(2).split("=");
    return [k, v];
  }),
);
const force = args.get("force") === "true";
const primaryTg = BigInt(args.get("primary-tg") ?? "782065541");
const secondaryTg = BigInt(args.get("secondary-tg") ?? "7778727321");

// Two commute origins in central Kyiv ~1.5km apart.
const ORIGIN_A = { lat: 50.4501, lng: 30.5234 }; // Maidan
const ORIGIN_B = { lat: 50.4419, lng: 30.5168 }; // Olimpiiska

let prisma;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, msg) => console.log(`\n━━━ [${n}] ${msg} ━━━`);

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
      throw new Error(`Telegram ${method} failed: ${json?.description ?? `${res.status} ${res.statusText}`}`);
    }
    return json.result;
  }
  return {
    raw: {
      sendMessageDraft: (p) => call("sendMessageDraft", p),
      editMessageText: (p) => call("editMessageText", p),
    },
    sendMessage: (chatId, text, options = {}) => call("sendMessage", { chat_id: chatId, text, ...options }),
    editMessageText: (chatId, messageId, text, options = {}) => call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options }),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId }),
    sendPhoto: (chatId, photo, options = {}) => call("sendPhoto", { chat_id: chatId, photo, ...options }),
    sendMediaGroup: (chatId, media, options = {}) => call("sendMediaGroup", { chat_id: chatId, media, ...options }),
    sendVoice: (chatId, voice, options = {}) => call("sendVoice", { chat_id: chatId, voice, ...options }),
    sendChatAction: (chatId, action) => call("sendChatAction", { chat_id: chatId, action }),
  };
}

function makeCtx(api, telegramId, language, { messageText, location } = {}) {
  let message;
  if (messageText !== undefined) message = { text: messageText };
  else if (location) message = { location };
  return {
    api,
    from: { id: Number(telegramId) },
    session: { language, matchFlow: "idle", activeMatchId: null },
    message,
    answerCallbackQuery: async () => {},
    reply: async (text, opts) => api.sendMessage(Number(telegramId), text, opts ?? {}),
    replyWithChatAction: async () => {},
  };
}

async function loadUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true, telegramId: true, firstName: true, status: true, onboardingStep: true,
      isEmailVerified: true, universityDomain: true, gender: true, preference: true, language: true,
      profile: { select: { photos: true, homeCityKey: true, latitude: true, longitude: true } },
    },
  });
}

function assertReady(label, u) {
  if (!u) throw new Error(`${label} not found.`);
  if (u.status !== "active") throw new Error(`${label} status=${u.status}, expected active.`);
  if (u.onboardingStep !== "completed") throw new Error(`${label} onboardingStep=${u.onboardingStep}, expected completed.`);
  if (!u.profile?.homeCityKey || u.profile.latitude === null || u.profile.longitude === null) {
    throw new Error(`${label} missing dating city/coordinates.`);
  }
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot).");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");

  const db = await import("@gennety/db");
  prisma = db.prisma;
  const { startScheduling } = await import("../apps/bot/src/handlers/matching/scheduler.js");
  const { processCalendarSlotsUpdate } = await import("../apps/bot/src/handlers/matching/scheduler.js");
  const { handleVenueVibe, handleVenueLocation } = await import("../apps/bot/src/handlers/matching/venue-negotiation.js");
  const { runDateLifecycleTick } = await import("../apps/bot/src/services/date-lifecycle.js");
  const { runPreDateSafetyTick } = await import("../apps/bot/src/services/pre-date-safety.js");
  const { runCoordinationTick } = await import("../apps/bot/src/services/coordination.js");

  const api = createTelegramApi(process.env.BOT_TOKEN);
  const primary = await loadUser(primaryTg);
  const secondary = await loadUser(secondaryTg);
  assertReady("Primary (A)", primary);
  assertReady("Secondary (B)", secondary);
  const langA = primary.language ?? "en";
  const langB = secondary.language ?? "en";

  // Find the most recent in-flight match between the pair.
  const match = await prisma.match.findFirst({
    where: {
      status: { in: OPEN_STATUSES },
      OR: [
        { userAId: primary.id, userBId: secondary.id },
        { userAId: secondary.id, userBId: primary.id },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, userAId: true },
  });
  if (!match) throw new Error("No in-flight match between the two accounts. Create one first (dev:trigger-test-match).");
  const matchId = match.id;
  // Map which side of THIS row is the primary, so calendar picks use the right tg.
  const aTg = match.userAId === primary.id ? primaryTg : secondaryTg;
  const bTg = match.userAId === primary.id ? secondaryTg : primaryTg;
  const aLang = match.userAId === primary.id ? langA : langB;
  const bLang = match.userAId === primary.id ? langB : langA;
  console.log(`Continuing match ${matchId} (status=${match.status})`);

  // ── 1. proposed → negotiating (bypass ticket gate) + scheduling ───────
  let row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, agreedTime: true, proposedTimes: true } });
  if (row.status === "proposed") {
    step("1", "Mutual accept (ticket gate bypassed) → startScheduling");
    await prisma.match.update({
      where: { id: matchId },
      data: { acceptedByA: true, acceptedByB: true, status: "negotiating", dispatchedAt: new Date() },
    });
    await startScheduling(api, matchId);
    await sleep(1500);
    row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, agreedTime: true, proposedTimes: true } });
  }

  // ── 2. negotiating → negotiating_venue (auto single-overlap lock) ─────
  if (row.status === "negotiating" && !row.agreedTime) {
    step("2", "Calendar: A offers 3 slots, B picks 1 → single-overlap auto-lock");
    const slots = row.proposedTimes.map((d) => new Date(d).toISOString());
    await processCalendarSlotsUpdate(api, aTg, matchId, [slots[0], slots[1], slots[2]]);
    await sleep(1200);
    await processCalendarSlotsUpdate(api, bTg, matchId, [slots[1]]);
    await sleep(1500);
    row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, agreedTime: true } });
  }

  // ── 3. negotiating_venue → scheduled (auto vibe + commute) ────────────
  if (row.status === "negotiating_venue") {
    step("3", "Venue: vibe + commute origin both sides → real Places venue → scheduled");
    await handleVenueVibe(makeCtx(api, aTg, aLang, { messageText: "quiet cozy cafe" }));
    await sleep(800);
    await handleVenueLocation(makeCtx(api, aTg, aLang, { location: { latitude: ORIGIN_A.lat, longitude: ORIGIN_A.lng } }));
    await sleep(1000);
    await handleVenueVibe(makeCtx(api, bTg, bLang, { messageText: "chill coffee place" }));
    await sleep(800);
    await handleVenueLocation(makeCtx(api, bTg, bLang, { location: { latitude: ORIGIN_B.lat, longitude: ORIGIN_B.lng } }));
    await sleep(2500);
    row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, agreedTime: true, venueName: true, venueAddress: true } });
    console.log(`venue: ${row.venueName ?? "?"} — ${row.venueAddress ?? "?"}`);
  }

  if (row.status !== "scheduled" || !row.agreedTime) {
    console.log(`\nStopped before lifecycle: status=${row.status}, agreedTime=${row.agreedTime ?? "null"}. (Venue resolution may have failed — check PLACES_API_KEY / logs.)`);
    return;
  }
  const agreedTime = row.agreedTime;

  // ── 4. Lifecycle ticks with crafted `now` (current-constant offsets) ──
  step("4", "Date-lifecycle ticks (accompanying messages)");
  async function tick(label, offsetHours) {
    const now = new Date(agreedTime.getTime() + offsetHours * 3600 * 1000);
    // Mirror index.ts: the date-lifecycle interval runs all THREE ticks.
    const [lifecycle, safety, coordination] = await Promise.all([
      runDateLifecycleTick(api, now),
      runPreDateSafetyTick(api, now),
      runCoordinationTick(api, now),
    ]);
    const merged = { ...lifecycle, safety: safety.sent, coordOffers: coordination.offers, proxyOpened: coordination.opened, proxyClosed: coordination.closed };
    console.log(`  ${label.padEnd(34)} → ${JSON.stringify(merged)}`);
    await sleep(1800);
  }
  await tick("T-5h  ice-breakers + emergency", -5);
  await tick("T-1.5h safety brief + wingman", -1.5);
  await tick("T-1h  coordination offer", -1);
  await tick("T-30m proxy chat open", -0.5);
  await tick("T+24h feedback prompt", 24);

  const final = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true, agreedTime: true, venueName: true, venueAddress: true,
      icebreakersSentAt: true, safetyNoteSentAt: true, wingmanSentAt: true,
      coordOfferSentAt: true, proxyOpenedAt: true, feedbackPromptedAt: true,
    },
  });
  step("DONE", "Date lifecycle played out");
  console.log(JSON.stringify({
    matchId,
    status: final.status,
    agreedTime: final.agreedTime?.toISOString(),
    venue: `${final.venueName} — ${final.venueAddress}`,
    sent: {
      icebreakers: !!final.icebreakersSentAt,
      safety: !!final.safetyNoteSentAt,
      wingman: !!final.wingmanSentAt,
      coordinationOffer: !!final.coordOfferSentAt,
      proxyOpened: !!final.proxyOpenedAt,
      feedbackPrompt: !!final.feedbackPromptedAt,
    },
  }, null, 2));
}

main()
  .finally(async () => { await prisma?.$disconnect(); })
  .catch((err) => { console.error("\nCONTINUE-DATE FAILED:", err instanceof Error ? err.stack : err); process.exitCode = 1; });
