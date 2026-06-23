#!/usr/bin/env node
/**
 * Dev-only helper (local dev bot only).
 *
 * Opens the Variant C anonymous **proxy chat** (PRODUCT_SPEC.md §Phase 4,
 * "Pre-date Coordination") on the most recent in-flight match between the two
 * test accounts, so you can manually test the bot↔partner text relay
 * end-to-end inside Telegram.
 *
 * It faithfully replicates the real T-30m `openProxies` step
 * (apps/bot/src/services/coordination.ts):
 *   - locks the match into Variant C (`coordMethod = "proxy"` + initiator
 *     bookkeeping, mirroring handleCoordMethod's proxy branch), and
 *   - stamps `proxyOpenedAt` / `proxyClosesAt` (window OPEN), then
 *   - DMs BOTH accounts the real `coordProxyOpenedEnterPrompt` + the real
 *     "Enter chat" button (callback `coord:enter:{matchId}`).
 *
 * Tapping that button flows through the real handleCoordEnter +
 * handleProxyRelay handlers in your running dev bot — those handlers are
 * registered unconditionally (the COORDINATION_FEATURE_ENABLED flag only gates
 * the cron), so the relay test is the genuine code path.
 *
 * Unlike dev-continue-date.mjs this runs NO lifecycle ticks, so it never fires
 * the T+24h close — the window stays open (default 2h real-time, --hours to
 * change) for live testing regardless of the match's agreedTime.
 *
 * Prereqs: `pnpm dev:bot` must be running so taps are handled.
 *
 * Usage (dry-run — inspect + show what it would do, no writes/sends):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-open-proxy-chat.mjs
 * Apply (open the window + DM both the Enter-chat button):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-open-proxy-chat.mjs --apply
 * Options:
 *   --primary-tg=782065541 --secondary-tg=5986970093
 *   --hours=2     proxy window length in hours (real-time, default 2)
 *   --force       bypass the gennetytestbot / dev-DB guards
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
const apply = args.get("apply") === "true";
const force = args.get("force") === "true";
const primaryTg = BigInt(args.get("primary-tg") ?? "782065541");
const secondaryTg = BigInt(args.get("secondary-tg") ?? "5986970093");
const windowHours = Number(args.get("hours") ?? "2");

let prisma;
let t;

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
      throw new Error(
        `Telegram ${method} failed: ${json?.description ?? `${res.status} ${res.statusText}`}`,
      );
    }
    return json.result;
  }
  return {
    sendMessage: (chatId, text, options = {}) =>
      call("sendMessage", { chat_id: chatId, text, ...options }),
  };
}

const participantSelect = {
  id: true,
  telegramId: true,
  language: true,
  firstName: true,
  gender: true,
  telegramUsername: true,
};

async function loadUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, telegramId: true, firstName: true, status: true },
  });
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Use --force to override.");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database. Use --force to override.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error(`--hours must be a positive number (got ${args.get("hours")}).`);
  }

  const db = await import("@gennety/db");
  prisma = db.prisma;
  ({ t } = await import("@gennety/shared"));

  const api = createTelegramApi(process.env.BOT_TOKEN);
  const primary = await loadUser(primaryTg);
  const secondary = await loadUser(secondaryTg);
  if (!primary) throw new Error(`Primary account telegramId=${primaryTg} not found in dev DB.`);
  if (!secondary) throw new Error(`Secondary account telegramId=${secondaryTg} not found in dev DB.`);

  // Most recent in-flight match between the pair; else the most recent of any
  // status (the proxy relay handlers don't gate on Match.status, only on the
  // proxy window + participation, so any existing match is functionally fine).
  const pairWhere = {
    OR: [
      { userAId: primary.id, userBId: secondary.id },
      { userAId: secondary.id, userBId: primary.id },
    ],
  };
  let match = await prisma.match.findFirst({
    where: { ...pairWhere, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, agreedTime: true, createdAt: true,
      coordMethod: true, coordInitiatorId: true,
      proxyOpenedAt: true, proxyClosesAt: true, proxyClosedAt: true,
      userAId: true, userBId: true,
      userA: { select: participantSelect },
      userB: { select: participantSelect },
    },
  });
  let fellBack = false;
  if (!match) {
    match = await prisma.match.findFirst({
      where: pairWhere,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, status: true, agreedTime: true, createdAt: true,
        coordMethod: true, coordInitiatorId: true,
        proxyOpenedAt: true, proxyClosesAt: true, proxyClosedAt: true,
        userAId: true, userBId: true,
        userA: { select: participantSelect },
        userB: { select: participantSelect },
      },
    });
    fellBack = true;
  }
  if (!match) {
    throw new Error(
      "No match exists between the two accounts. Create one first:\n" +
      "  pnpm dev:trigger-test-match",
    );
  }

  console.log(`\nAccounts:`);
  console.log(`  A: ${match.userA.firstName ?? "?"} (tg ${match.userA.telegramId}, ${match.userA.gender ?? "?"}, @${match.userA.telegramUsername ?? "—"})`);
  console.log(`  B: ${match.userB.firstName ?? "?"} (tg ${match.userB.telegramId}, ${match.userB.gender ?? "?"}, @${match.userB.telegramUsername ?? "—"})`);
  console.log(`\nMatch ${match.id}`);
  console.log(`  status        : ${match.status}${fellBack ? "  (⚠ not in-flight — proxy still works on it)" : ""}`);
  console.log(`  agreedTime    : ${match.agreedTime?.toISOString() ?? "null (not needed for the proxy relay)"}`);
  console.log(`  coordMethod   : ${match.coordMethod ?? "null"}`);
  console.log(`  proxyOpenedAt : ${match.proxyOpenedAt?.toISOString() ?? "null"}`);
  console.log(`  proxyClosesAt : ${match.proxyClosesAt?.toISOString() ?? "null"}`);
  console.log(`  proxyClosedAt : ${match.proxyClosedAt?.toISOString() ?? "null"}`);

  // Pick the initiator the way resolveCoordRecipients/handleCoordMethod would:
  // the female participant if there is exactly one, otherwise userA.
  const females = [match.userA, match.userB].filter((u) => u.gender === "female");
  const initiator = females.length === 1 ? females[0] : match.userA;

  const now = new Date();
  const closesAt = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  if (!apply) {
    console.log(`\n[DRY RUN] Would, on --apply:`);
    console.log(`  • set coordMethod=proxy, coordInitiatorId=${initiator.id} (${initiator.firstName ?? "?"})`);
    console.log(`  • set proxyOpenedAt=${now.toISOString()}  proxyClosesAt=${closesAt.toISOString()}  proxyClosedAt=null`);
    console.log(`  • DM BOTH accounts the real "Enter chat" prompt + button (coord:enter:${match.id})`);
    console.log(`\nRe-run with --apply to do it. Make sure \`pnpm dev:bot\` is running first.`);
    return;
  }

  // 1) Lock Variant C + open the window (mirror handleCoordMethod proxy branch
  //    + openProxies). proxyClosedAt=null so a re-run re-opens a stale window.
  await prisma.match.update({
    where: { id: match.id },
    data: {
      coordMethod: "proxy",
      coordInitiatorId: initiator.id,
      coordChosenAt: now,
      coordResolvedAt: now,
      proxyOpenedAt: now,
      proxyClosesAt: closesAt,
      proxyClosedAt: null,
    },
  });

  // 2) DM both sides the real open prompt + Enter-chat button, each in their
  //    own language (mirror openProxies).
  let sent = 0;
  for (const u of [match.userA, match.userB]) {
    if (u.telegramId <= 0n) {
      console.warn(`  skip ${u.firstName ?? u.id}: synthetic/mobile telegramId ${u.telegramId}`);
      continue;
    }
    const lang = u.language ?? "en";
    try {
      await api.sendMessage(Number(u.telegramId), t(lang, "coordProxyOpenedEnterPrompt"), {
        reply_markup: {
          inline_keyboard: [[{ text: t(lang, "coordEnterBtn"), callback_data: `coord:enter:${match.id}` }]],
        },
      });
      sent++;
      console.log(`  ✓ sent Enter-chat button to ${u.firstName ?? u.id} (tg ${u.telegramId})`);
    } catch (err) {
      console.warn(`  ✗ send failed for tg ${u.telegramId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n✅ Proxy chat OPEN on match ${match.id} until ${closesAt.toISOString()} (${windowHours}h).`);
  console.log(`   Buttons sent: ${sent}/2.`);
  console.log(`\nNow on each account:`);
  console.log(`   1. Tap "💬 Enter chat".`);
  console.log(`   2. Type a message on account A — it relays to B prefixed "💬 Your date: ".`);
  console.log(`   3. Reply on B — relays back to A. Each relayed message carries Leave/Report.`);
  console.log(`   4. Try sending a photo/voice — it's rejected (text-only).`);
  console.log(`   (Requires \`pnpm dev:bot\` running. Window auto-expires after ${windowHours}h; re-run --apply to reopen.)`);
}

main()
  .finally(async () => { await prisma?.$disconnect(); })
  .catch((err) => {
    console.error("\nOPEN-PROXY FAILED:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
