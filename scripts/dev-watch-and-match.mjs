#!/usr/bin/env node
/**
 * Dev-only: watch the two local Telegram test accounts and AUTO-TRIGGER a
 * match the instant BOTH have finished onboarding (onboardingStep=completed).
 *
 * Lets the developer walk onboarding manually on both accounts; this poller
 * fires `createProposedMatch` + `dispatchMatches` (the real pitch DM) as soon
 * as both are ready, then exits. After that the developer continues the rest
 * of the journey manually in Telegram (accept → calendar → venue → ...).
 *
 * Idempotent: bails if an in-flight match already exists between them, so a
 * second invocation won't double-pitch.
 *
 * Usage: pnpm dev:watch-and-match
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function loadEnv(p, ov) {
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const e = t.indexOf("=");
    if (e === -1) continue;
    const k = t.slice(0, e).trim();
    let v = t.slice(e + 1).trim().replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (ov || process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv(resolve(root, ".env.local"), true);
loadEnv(resolve(root, ".env"), false);

const IDS = { A: 782065541n, B: 5986970093n };
const OPEN = ["proposed", "negotiating", "negotiating_venue", "scheduled"];
const POLL_MS = 8000;
const MAX_RUNTIME_MS = 3 * 60 * 60 * 1000; // 3h safety stop
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (
  process.env.BOT_USERNAME !== "gennetytestbot" ||
  !process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev")
) {
  throw new Error(
    "Refusing to run: expected BOT_USERNAME=gennetytestbot and the local localhost:5434/gennety_dev database.",
  );
}

function telegramApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  const call = async (m, p) => {
    const res = await fetch(`${base}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(`Telegram ${m} failed: ${j?.description ?? res.status}`);
    return j.result;
  };
  return {
    raw: { sendMessageDraft: (p) => call("sendMessageDraft", p), editMessageText: (p) => call("editMessageText", p) },
    sendMessage: (c, t, o = {}) => call("sendMessage", { chat_id: c, text: t, ...o }),
    editMessageText: (c, m, t, o = {}) => call("editMessageText", { chat_id: c, message_id: m, text: t, ...o }),
    sendPhoto: (c, p, o = {}) => call("sendPhoto", { chat_id: c, photo: p, ...o }),
    sendMediaGroup: (c, md, o = {}) => call("sendMediaGroup", { chat_id: c, media: md, ...o }),
    sendChatAction: (c, a) => call("sendChatAction", { chat_id: c, action: a }),
  };
}

const { prisma } = await import("@gennety/db");
const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
const { dispatchMatches } = await import("../apps/bot/src/services/dispatch-queue.js");
const api = telegramApi(process.env.BOT_TOKEN);

async function snapshot() {
  const rows = await prisma.user.findMany({
    where: { telegramId: { in: [IDS.A, IDS.B] } },
    select: { id: true, telegramId: true, firstName: true, status: true, onboardingStep: true, profile: { select: { photos: true } } },
  });
  const a = rows.find((r) => r.telegramId === IDS.A);
  const b = rows.find((r) => r.telegramId === IDS.B);
  return { a, b };
}

const started = Date.now();
console.log(`[watch] polling every ${POLL_MS / 1000}s — waiting for BOTH accounts to reach onboardingStep=completed…`);

let last = "";
while (Date.now() - started < MAX_RUNTIME_MS) {
  const { a, b } = await snapshot();
  if (!a || !b) { console.log("[watch] one account row missing — did you /start both?"); await sleep(POLL_MS); continue; }

  const line = `A(${a.firstName ?? "?"})=${a.onboardingStep}/${a.status} photos:${a.profile?.photos?.length ?? 0} | B(${b.firstName ?? "?"})=${b.onboardingStep}/${b.status} photos:${b.profile?.photos?.length ?? 0}`;
  if (line !== last) { console.log(`[watch] ${line}`); last = line; }

  if (a.onboardingStep === "completed" && b.onboardingStep === "completed") {
    const open = await prisma.match.findMany({
      where: { status: { in: OPEN }, OR: [{ userAId: { in: [a.id, b.id] } }, { userBId: { in: [a.id, b.id] } }] },
      select: { id: true, status: true },
    });
    if (open.length > 0) {
      console.log(`[watch] both completed, but an in-flight match already exists (${open.map((m) => m.status).join(",")}). Nothing to do — exiting.`);
      break;
    }
    console.log("[watch] ✅ both accounts completed onboarding — triggering the match!");
    const match = await createProposedMatch(a.id, b.id, {
      explicit: 0.88, research: 0.78, league: 1, penalty: 0, embeddingDistance: 0.24, starvationBonus: 0,
    });
    const d = await dispatchMatches(api, [match.id], 0);
    if (d.failed > 0) { console.error("[watch] dispatch failed:", JSON.stringify(d.errors)); process.exitCode = 1; }
    else console.log(`[watch] 🎉 match ${match.id} created + pitch dispatched to both accounts. Continue manually in Telegram (Accept → Calendar → Venue).`);
    break;
  }
  await sleep(POLL_MS);
}

if (Date.now() - started >= MAX_RUNTIME_MS) console.log("[watch] max runtime reached — stopping. Re-run `pnpm dev:watch-and-match` when ready.");
await prisma.$disconnect();
