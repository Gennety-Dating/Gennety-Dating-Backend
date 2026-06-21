#!/usr/bin/env node
/**
 * Dev-only END-TO-END auto-flow driver (local DEP bot only).
 *
 * Chains the entire post-onboarding user journey between the two local
 * Telegram test accounts WITHOUT any manual taps. Each stage drives the
 * real production service/handler functions (not fakes), so every step
 * fires the genuine Telegram DMs both accounts would see in the wild:
 *
 *   1. createProposedMatch + dispatchMatches   → pitch DM + Accept/Decline
 *   2. handleMatchDecision (accept A, accept B) → mutual accept, negotiating
 *   3. processCalendarSlotsUpdate (A then B)    → single-overlap auto-lock
 *   4. handleVenueVibe / handleVenueLocation    → tryFinalize → scheduled
 *   5. runDateLifecycleTick x3 (crafted `now`)  → icebreakers, wingman, feedback
 *   6. recordPostDateFeedback (A and B)         → feedbackByA/B + LLM analysis
 *
 * The grammY-bound handlers are driven through a minimal hand-built ctx;
 * the engine/service functions take a plain Telegram fetch shim as `api`
 * (same shim the shipped dev-trigger-test-match.mjs uses for dispatch).
 *
 * Usage:
 *   pnpm dev:e2e-full-flow
 *
 * Optional:
 *   --primary-tg=782065541 --secondary-tg=5986970093
 *   --keep-open        do NOT cancel existing in-flight matches first
 *   --force            bypass the gennetytestbot guard
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
const secondaryTg = BigInt(args.get("secondary-tg") ?? "5986970093");

// Two commute origins in central Kyiv ~1.5km apart (the venue picker
// resolves a fair midpoint cafe between them).
const ORIGIN_A = { lat: 50.4501, lng: 30.5234 }; // Maidan
const ORIGIN_B = { lat: 50.4419, lng: 30.5168 }; // Olimpiiska

let prisma;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(n, msg) {
  console.log(`\n━━━ [${n}] ${msg} ━━━`);
}

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
    raw: {
      sendMessageDraft: (payload) => call("sendMessageDraft", payload),
      editMessageText: (payload) => call("editMessageText", payload),
    },
    sendMessage: (chatId, text, options = {}) =>
      call("sendMessage", { chat_id: chatId, text, ...options }),
    editMessageText: (chatId, messageId, text, options = {}) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options }),
    sendPhoto: (chatId, photo, options = {}) =>
      call("sendPhoto", { chat_id: chatId, photo, ...options }),
    sendMediaGroup: (chatId, media, options = {}) =>
      call("sendMediaGroup", { chat_id: chatId, media, ...options }),
    sendChatAction: (chatId, action) =>
      call("sendChatAction", { chat_id: chatId, action }),
  };
}

/** Minimal grammY-ctx stand-in for the decision / venue handlers. */
function makeCtx(api, telegramId, language, { callbackData, messageText, location } = {}) {
  let message;
  if (messageText !== undefined) message = { text: messageText };
  else if (location) message = { location };
  return {
    api,
    from: { id: Number(telegramId) },
    session: { language, matchFlow: "idle", activeMatchId: null },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
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
      id: true, telegramId: true, firstName: true, status: true,
      onboardingStep: true, isEmailVerified: true, universityDomain: true,
      gender: true, preference: true, verificationStatus: true, language: true,
      profile: {
        select: {
          photos: true,
          homeCityKey: true,
          latitude: true,
          longitude: true,
        },
      },
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
  if (process.env.TICKET_FEATURE_ENABLED === "true") {
    throw new Error(
      "Set TICKET_FEATURE_ENABLED=false and restart the bot for this automated no-ticket flow. Test the ticket gate manually in its separate QA pass.",
    );
  }

  const db = await import("@gennety/db");
  prisma = db.prisma;
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { dispatchMatches } = await import("../apps/bot/src/services/dispatch-queue.js");
  const { handleMatchDecision } = await import("../apps/bot/src/handlers/matching/decision.js");
  const { processCalendarSlotsUpdate } = await import("../apps/bot/src/handlers/matching/scheduler.js");
  const { handleVenueVibe, handleVenueLocation } = await import("../apps/bot/src/handlers/matching/venue-negotiation.js");
  const { runDateLifecycleTick } = await import("../apps/bot/src/services/date-lifecycle.js");
  const { recordPostDateFeedback } = await import("../apps/bot/src/handlers/date/feedback.js");

  const api = createTelegramApi(process.env.BOT_TOKEN);

  const primary = await loadUser(primaryTg);
  const secondary = await loadUser(secondaryTg);
  assertReady("Primary (A)", primary);
  assertReady("Secondary (B)", secondary);
  if (primary.profile.homeCityKey !== secondary.profile.homeCityKey) {
    throw new Error(
      `Dating cities differ: ${primary.profile.homeCityKey} vs ${secondary.profile.homeCityKey}.`,
    );
  }
  const langA = primary.language ?? "en";
  const langB = secondary.language ?? "en";

  console.log(JSON.stringify({
    bot: process.env.BOT_USERNAME,
    A: { tg: primary.telegramId.toString(), name: primary.firstName, gender: primary.gender, city: primary.profile.homeCityKey, photos: primary.profile.photos.length },
    B: { tg: secondary.telegramId.toString(), name: secondary.firstName, gender: secondary.gender, city: secondary.profile.homeCityKey, photos: secondary.profile.photos.length },
  }, null, 2));
  if ((primary.profile?.photos?.length ?? 0) === 0 || (secondary.profile?.photos?.length ?? 0) === 0) {
    console.log("NOTE: one or both profiles have 0 photos — the pitch photo card is skipped (text-only pitch). All other stages run normally.");
  }

  // ── 0. Clean up stale in-flight matches ───────────────────────────────
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
      step("0", `Cancelled ${open.length} stale in-flight match(es).`);
    }
  }

  // ── 1. Create + dispatch the proposed match (pitch DM) ────────────────
  step("1", "Create proposed match + dispatch pitch");
  const match = await createProposedMatch(primary.id, secondary.id, {
    explicit: 0.88, research: 0.78, league: 1, penalty: 0, embeddingDistance: 0.24, starvationBonus: 0,
  });
  const matchId = match.id;
  const dispatch = await dispatchMatches(api, [matchId], 0);
  if (dispatch.failed > 0) throw new Error(`Dispatch failed: ${JSON.stringify(dispatch.errors)}`);
  console.log(`matchId=${matchId} pitch dispatched.`);
  await sleep(1500);

  // ── 2. Accept on both sides (blind decision → mutual accept) ──────────
  step("2", "Accept (A first decider, then B → mutual accept → negotiating)");
  await handleMatchDecision(makeCtx(api, primaryTg, langA, { callbackData: `match:accept:${matchId}` }));
  await sleep(1200);
  await handleMatchDecision(makeCtx(api, secondaryTg, langB, { callbackData: `match:accept:${matchId}` }));
  await sleep(1500);
  let row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, proposedTimes: true } });
  console.log(`status=${row.status} proposedSlots=${row.proposedTimes.length}`);
  if (row.status !== "negotiating") throw new Error(`Expected negotiating after mutual accept, got ${row.status}.`);

  // ── 3. Calendar: A offers 3 slots, B picks 1 → single-overlap auto-lock ─
  step("3", "Calendar picks → single-overlap auto-lock → venue negotiation");
  const slots = row.proposedTimes.map((d) => new Date(d).toISOString());
  const aPicks = [slots[0], slots[1], slots[2]];
  const bPick = [slots[1]];
  const rA = await processCalendarSlotsUpdate(api, primaryTg, matchId, aPicks);
  console.log(`A picks 3 → ok=${rA.ok} agreed=${rA.agreedTime ?? "none"}`);
  await sleep(1200);
  const rB = await processCalendarSlotsUpdate(api, secondaryTg, matchId, bPick);
  console.log(`B picks 1 → ok=${rB.ok} agreed=${rB.agreedTime ?? "none"}`);
  await sleep(1500);
  row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, agreedTime: true } });
  console.log(`status=${row.status} agreedTime=${row.agreedTime?.toISOString() ?? "null"}`);
  if (row.status !== "negotiating_venue" || !row.agreedTime) {
    throw new Error(`Expected negotiating_venue + agreedTime, got status=${row.status}.`);
  }
  const agreedTime = row.agreedTime;

  // ── 4. Venue: vibe + location both sides → tryFinalize → scheduled ────
  step("4", "Vibe + commute location (both) → venue resolve → scheduled");
  await handleVenueVibe(makeCtx(api, primaryTg, langA, { messageText: "quiet cozy cafe" }));
  await sleep(800);
  await handleVenueLocation(makeCtx(api, primaryTg, langA, { location: { latitude: ORIGIN_A.lat, longitude: ORIGIN_A.lng } }));
  await sleep(1000);
  await handleVenueVibe(makeCtx(api, secondaryTg, langB, { messageText: "chill coffee place" }));
  await sleep(800);
  // This last save completes the data set → tryFinalize runs the venue pipeline.
  await handleVenueLocation(makeCtx(api, secondaryTg, langB, { location: { latitude: ORIGIN_B.lat, longitude: ORIGIN_B.lng } }));
  await sleep(2000);
  row = await prisma.match.findUnique({
    where: { id: matchId },
    select: { status: true, venueName: true, venueAddress: true, venueGoogleMapsUri: true },
  });
  console.log(`status=${row.status} venue=${row.venueName ?? "?"} | ${row.venueAddress ?? "?"}`);
  if (row.status !== "scheduled") throw new Error(`Expected scheduled after venue resolve, got ${row.status}.`);

  // ── 5. Date lifecycle — 3 ticks with crafted `now` relative to agreedTime ─
  step("5", "Date lifecycle ticks (icebreakers → wingman → feedback prompt)");
  const t1 = new Date(agreedTime.getTime() - 2 * 60 * 60 * 1000);       // T-2h → icebreakers + emergency window
  const r1 = await runDateLifecycleTick(api, t1);
  console.log(`tick T-2h: ${JSON.stringify(r1)}`);
  await sleep(1500);
  const t2 = new Date(agreedTime.getTime() - 30 * 60 * 1000);           // T-30m → wingman reveal
  const r2 = await runDateLifecycleTick(api, t2);
  console.log(`tick T-30m: ${JSON.stringify(r2)}`);
  await sleep(1500);
  const t3 = new Date(agreedTime.getTime() + 25 * 60 * 60 * 1000);      // T+25h → feedback prompt + status completed
  const r3 = await runDateLifecycleTick(api, t3);
  console.log(`tick T+25h: ${JSON.stringify(r3)}`);
  await sleep(1500);
  row = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, feedbackPromptedAt: true } });
  console.log(`status=${row.status} feedbackPromptedAt=${row.feedbackPromptedAt?.toISOString() ?? "null"}`);
  if (row.status !== "completed") throw new Error(`Expected completed after feedback tick, got ${row.status}.`);

  // ── 6. Post-date feedback (both sides) ────────────────────────────────
  step("6", "Record post-date feedback (both sides)");
  const fbA = await recordPostDateFeedback({
    userId: primary.id, matchId, language: langA,
    text: "Chemistry 8/10. Yes to a second date. Great conversation, she was funny and easy to talk to. Slightly nervous at first.",
  });
  const fbB = await recordPostDateFeedback({
    userId: secondary.id, matchId, language: langB,
    text: "Chemistry 7/10. Maybe a second date. Nice guy, polite. Wish he asked more questions about me.",
  });
  console.log(`feedback A=${JSON.stringify(fbA)} B=${JSON.stringify(fbB)}`);

  // ── Final summary ─────────────────────────────────────────────────────
  const final = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true, agreedTime: true, venueName: true, venueAddress: true,
      acceptedByA: true, acceptedByB: true, icebreakersSentAt: true,
      wingmanSentAt: true, feedbackPromptedAt: true, feedbackByA: true, feedbackByB: true,
    },
  });
  step("DONE", "Full E2E flow complete");
  console.log(JSON.stringify({
    matchId,
    status: final.status,
    agreedTime: final.agreedTime?.toISOString(),
    venue: `${final.venueName} — ${final.venueAddress}`,
    accepted: { A: final.acceptedByA, B: final.acceptedByB },
    icebreakersSent: !!final.icebreakersSentAt,
    wingmanSent: !!final.wingmanSentAt,
    feedbackPrompted: !!final.feedbackPromptedAt,
    feedback: { A: !!final.feedbackByA, B: !!final.feedbackByB },
  }, null, 2));
}

main()
  .finally(async () => { await prisma?.$disconnect(); })
  .catch((err) => {
    console.error("\nE2E FLOW FAILED:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
