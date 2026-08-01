#!/usr/bin/env node
/**
 * Dev-only helper (local dev bot only).
 *
 * Interactive playground for the **pre-date coordination offer**
 * (PRODUCT_SPEC.md §Phase 4, "Pre-date Coordination" — the T-60m DM that lets
 * the two matched accounts find each other at the venue: A) share my
 * Telegram, B) ask for theirs, C) anonymous bot-relayed chat).
 *
 * Unlike `dev-continue-date.mjs` (which fires the offer once, as part of the
 * full lifecycle walk, and is not meant to be re-run mid-flow) this script is
 * built for going back and forth: send the real offer DM(s), tap a button in
 * Telegram, play the whole variant out end-to-end, then `--reset` the match's
 * coordination state and send a fresh offer to try a *different* variant —
 * as many times as you want, without recreating the match.
 *
 * It sends the REAL copy/buttons (`coordOfferIntro`, `coordBtnShareSelf`,
 * `coordBtnRequestPartner`, `coordBtnProxy`) with the REAL callback data
 * (`coord:m:{matchId}:{method}`), so tapping a button in your running
 * `pnpm dev:bot` flows through the genuine `handleCoordMethod` /
 * `handleCoordConsent` / `handleCoordEnter` / `handleProxyRelay` handlers —
 * those are registered unconditionally in `dateRouter`
 * (`COORDINATION_FEATURE_ENABLED` only gates the cron sweep), so this works
 * whether or not the flag is on.
 *
 * Prereqs: `pnpm dev:bot` must be running so taps are handled, and a match
 * between the two accounts must already exist and be `scheduled`. If you
 * don't have one yet:
 *   pnpm dev:trigger-test-match
 *   node scripts/dev-continue-date.mjs -- --stop-at=scheduled
 *
 * Usage (status only — no writes, no sends):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-coord-offer-demo.mjs
 *
 * Send the real offer DM(s) (auto-resets coordination state first, so it's
 * always safe to re-run to try a different variant from scratch):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-coord-offer-demo.mjs --send-offer --apply
 *
 * Just wipe the chosen variant / proxy state without sending a new offer
 * (e.g. to inspect a clean row, or before triggering the offer some other way):
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-coord-offer-demo.mjs --reset --apply
 *
 * Options:
 *   --primary-tg=782065541 --secondary-tg=5986970093
 *   --minutes-until-date=25   how far out to set agreedTime (default 25 min —
 *                             inside BOTH the 60m offer window and the 30m
 *                             proxy-open window, so if you pick Variant C the
 *                             very next date-lifecycle tick opens it too,
 *                             instead of you waiting for real wall-clock time
 *                             to creep up on the date)
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
const COORD_OFFER_MINUTES = 60; // COORD_OFFER_HOURS from packages/shared
const PROXY_OPEN_MINUTES = 30; // PROXY_OPEN_HOURS from packages/shared
const PROXY_CLOSE_AFTER_HOURS = 2; // PROXY_CLOSE_AFTER_HOURS from packages/shared

const args = new Map(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.slice(2).split("=");
    return [k, v];
  }),
);
const apply = args.get("apply") === "true";
const force = args.get("force") === "true";
const doReset = args.get("reset") === "true";
const doSendOffer = args.get("send-offer") === "true";
const primaryTg = BigInt(args.get("primary-tg") ?? "782065541");
const secondaryTg = BigInt(args.get("secondary-tg") ?? "5986970093");
const minutesUntilDate = Number(args.get("minutes-until-date") ?? "25");

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

// Mirrors resolveCoordRecipients() in apps/bot/src/services/coordination.ts:
// the female participant gets the offer; a same-sex pair with no female gets
// both (first-tap-wins).
function resolveRecipients(a, b) {
  const telegramBoth = [a, b].filter((u) => u.telegramId > 0n);
  if (telegramBoth.length < 2) return [];
  const females = telegramBoth.filter((u) => u.gender === "female");
  return females.length > 0 ? females : telegramBoth;
}

function fmt(d) {
  return d ? d.toISOString() : "null";
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error("Refusing to run outside the dev bot (BOT_USERNAME=gennetytestbot). Use --force to override.");
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing to run outside the local localhost:5434/gennety_dev database. Use --force to override.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN in local env.");
  if (!Number.isFinite(minutesUntilDate) || minutesUntilDate <= 0 || minutesUntilDate > COORD_OFFER_MINUTES) {
    throw new Error(`--minutes-until-date must be between 1 and ${COORD_OFFER_MINUTES} (got ${args.get("minutes-until-date")}).`);
  }

  const db = await import("@gennety/db");
  prisma = db.prisma;
  ({ t } = await import("@gennety/shared"));

  const api = createTelegramApi(process.env.BOT_TOKEN);
  const primary = await loadUser(primaryTg);
  const secondary = await loadUser(secondaryTg);
  if (!primary) throw new Error(`Primary account telegramId=${primaryTg} not found in dev DB.`);
  if (!secondary) throw new Error(`Secondary account telegramId=${secondaryTg} not found in dev DB.`);

  const pairWhere = {
    OR: [
      { userAId: primary.id, userBId: secondary.id },
      { userAId: secondary.id, userBId: primary.id },
    ],
  };
  const matchSelect = {
    id: true, status: true, agreedTime: true, createdAt: true,
    coordOfferSentAt: true, coordInitiatorId: true, coordMethod: true,
    coordChosenAt: true, coordPartnerConsent: true, coordResolvedAt: true,
    proxyOpenedAt: true, proxyClosesAt: true, proxyClosedAt: true,
    userAId: true, userBId: true,
    userA: { select: participantSelect },
    userB: { select: participantSelect },
  };

  let match = await prisma.match.findFirst({
    where: { ...pairWhere, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: matchSelect,
  });
  if (!match) {
    throw new Error(
      "No in-flight match between the two accounts. Create + advance one first:\n" +
      "  pnpm dev:trigger-test-match\n" +
      "  node scripts/dev-continue-date.mjs -- --stop-at=scheduled",
    );
  }

  console.log(`\nAccounts:`);
  console.log(`  A: ${match.userA.firstName ?? "?"} (tg ${match.userA.telegramId}, ${match.userA.gender ?? "?"}, @${match.userA.telegramUsername ?? "—"})`);
  console.log(`  B: ${match.userB.firstName ?? "?"} (tg ${match.userB.telegramId}, ${match.userB.gender ?? "?"}, @${match.userB.telegramUsername ?? "—"})`);
  console.log(`\nMatch ${match.id}`);
  console.log(`  status            : ${match.status}`);
  console.log(`  agreedTime        : ${fmt(match.agreedTime)}`);
  console.log(`  coordOfferSentAt  : ${fmt(match.coordOfferSentAt)}`);
  console.log(`  coordMethod       : ${match.coordMethod ?? "null"}`);
  console.log(`  coordInitiatorId  : ${match.coordInitiatorId ?? "null"}`);
  console.log(`  coordPartnerConsent: ${match.coordPartnerConsent ?? "null"}  (Variant B only)`);
  console.log(`  coordResolvedAt   : ${fmt(match.coordResolvedAt)}`);
  console.log(`  proxyOpenedAt     : ${fmt(match.proxyOpenedAt)}`);
  console.log(`  proxyClosesAt     : ${fmt(match.proxyClosesAt)}`);
  console.log(`  proxyClosedAt     : ${fmt(match.proxyClosedAt)}`);

  const recipients = resolveRecipients(match.userA, match.userB);
  console.log(`\nOffer recipient(s) (who gets asked to pick A/B/C): ${
    recipients.length ? recipients.map((r) => r.firstName ?? r.id).join(", ") : "none (missing/mobile telegramId)"
  }`);

  if (!doReset && !doSendOffer) {
    console.log(`\n[STATUS ONLY] Pass --send-offer --apply to DM the real offer, or --reset --apply to clear a previously-chosen variant.`);
    return;
  }

  const resetData = {
    coordOfferSentAt: null,
    coordInitiatorId: null,
    coordMethod: null,
    coordChosenAt: null,
    coordPartnerConsent: null,
    coordResolvedAt: null,
    proxyOpenedAt: null,
    proxyClosesAt: null,
    proxyClosedAt: null,
  };

  if (!apply) {
    console.log(`\n[DRY RUN] Would, on --apply:`);
    if (doReset || doSendOffer) {
      console.log(`  • clear all coordination/proxy state (coordMethod, coordInitiatorId, coordChosenAt,`);
      console.log(`    coordPartnerConsent, coordResolvedAt, proxy* → all null)`);
    }
    if (doSendOffer) {
      const now = new Date();
      const newAgreedTime = new Date(now.getTime() + minutesUntilDate * 60 * 1000);
      console.log(`  • set status=scheduled (if not already), agreedTime=${newAgreedTime.toISOString()} (T-${minutesUntilDate}m)`);
      console.log(`  • DM the real coordination offer to: ${recipients.map((r) => r.firstName ?? r.id).join(", ") || "(nobody eligible)"}`);
    }
    console.log(`\nRe-run with --apply to do it. Make sure \`pnpm dev:bot\` is running first.`);
    return;
  }

  // --- Apply -----------------------------------------------------------
  if (doSendOffer) {
    const now = new Date();
    const newAgreedTime = new Date(now.getTime() + minutesUntilDate * 60 * 1000);
    if (match.status !== "scheduled") {
      console.log(`  note: match status was "${match.status}", forcing to "scheduled" so the offer applies.`);
    }
    await prisma.match.update({
      where: { id: match.id },
      data: { ...resetData, status: "scheduled", agreedTime: newAgreedTime },
    });
    match = await prisma.match.findUnique({ where: { id: match.id }, select: matchSelect });
    console.log(`\n✅ Coordination state reset, agreedTime set to ${newAgreedTime.toISOString()} (T-${minutesUntilDate}m).`);

    const freshRecipients = resolveRecipients(match.userA, match.userB);
    if (freshRecipients.length === 0) {
      console.warn(`  ⚠ No eligible offer recipient (need a real telegramId on both sides). Nothing sent.`);
    } else {
      let sent = 0;
      for (const r of freshRecipients) {
        const partner = r.id === match.userA.id ? match.userB : match.userA;
        const lang = r.language ?? "en";
        const recipientHasUsername = Boolean(r.telegramUsername);
        const partnerHasUsername = Boolean(partner.telegramUsername);
        const intro = recipientHasUsername || partnerHasUsername
          ? t(lang, "coordOfferIntro")
          : t(lang, "coordOfferNoContactNote");
        const rows = [];
        if (recipientHasUsername) rows.push([{ text: t(lang, "coordBtnShareSelf"), callback_data: `coord:m:${match.id}:share_self` }]);
        if (partnerHasUsername) rows.push([{ text: t(lang, "coordBtnRequestPartner"), callback_data: `coord:m:${match.id}:request_partner` }]);
        rows.push([{ text: t(lang, "coordBtnProxy"), callback_data: `coord:m:${match.id}:proxy` }]);
        try {
          await api.sendMessage(Number(r.telegramId), intro, { reply_markup: { inline_keyboard: rows } });
          sent++;
          console.log(`  ✓ sent offer to ${r.firstName ?? r.id} (tg ${r.telegramId}) — buttons: ${
            [recipientHasUsername && "share_self", partnerHasUsername && "request_partner", "proxy"].filter(Boolean).join(", ")
          }`);
        } catch (err) {
          console.warn(`  ✗ send failed for tg ${r.telegramId}: ${err instanceof Error ? err.message : err}`);
        }
      }
      await prisma.match.update({ where: { id: match.id }, data: { coordOfferSentAt: now } });
      console.log(`\n✅ Offer sent: ${sent}/${freshRecipients.length}.`);
    }

    console.log(`\nNow in Telegram, on the recipient account:`);
    console.log(`  • Tap "📲 Share my Telegram" (Variant A) → partner gets your t.me link instantly.`);
    console.log(`  • Tap "🙋 Ask them for theirs" (Variant B) → partner gets an Approve/Decline card;`);
    console.log(`    tap Approve on THEIR account to reveal their t.me link back to the initiator.`);
    console.log(`  • Tap "🕶 Anonymous chat" (Variant C) → locks in Variant C; the window opens on the`);
    console.log(`    next date-lifecycle tick (agreedTime is inside the ${PROXY_OPEN_MINUTES}m open window, so`);
    console.log(`    this should be within ~2 min of real time) — both sides get an "Enter chat" button.`);
    console.log(`    Once open you can also force it instantly with:`);
    console.log(`      node scripts/dev-open-proxy-chat.mjs --apply`);
    console.log(`\nDone testing this variant? Reset and pick another:`);
    console.log(`  pnpm --filter @gennety/bot exec tsx ../../scripts/dev-coord-offer-demo.mjs --send-offer --apply`);
  } else if (doReset) {
    await prisma.match.update({ where: { id: match.id }, data: resetData });
    console.log(`\n✅ Coordination/proxy state cleared on match ${match.id}. Send a fresh offer with:`);
    console.log(`  pnpm --filter @gennety/bot exec tsx ../../scripts/dev-coord-offer-demo.mjs --send-offer --apply`);
  }
}

main()
  .finally(async () => { await prisma?.$disconnect(); })
  .catch((err) => {
    console.error("\nCOORD-OFFER-DEMO FAILED:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
