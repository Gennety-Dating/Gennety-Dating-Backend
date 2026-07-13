#!/usr/bin/env node
/**
 * Dev-only helper (local dev bot only).
 *
 * Stands up EVERY redesigned Mini App screen at once, so they can all be
 * reviewed in one sitting instead of re-staging between each one.
 *
 * The Mini Apps derive their screen from real match state (there is no preview
 * mode outside venue-change), and one pair can only be in one state at a time —
 * so this provisions ONE MATCH PER SCREEN and DMs each account a menu of
 * `web_app` buttons, once per theme (`?theme=` is honored by every Mini App).
 *
 * Screens covered:
 *   ticket gate  offer · cover-partner · waiting · success · partner-paid · closed
 *   calendar     slot grid with the partner's picks already on it (peer colour)
 *   venue board  open board on a scheduled date
 *   store        ticket bundles (no match needed)
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-all-screens.mjs --apply
 * Optional:
 *   --man-tg=782065541 --woman-tg=5986970093 --lang=ru
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const argv = new Map(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.slice(2).split("=");
    return [k, v];
  }),
);
const apply = argv.get("apply") === "true";
const force = argv.get("force") === "true";
const manTg = BigInt(argv.get("man-tg") ?? "782065541");
const womanTg = BigInt(argv.get("woman-tg") ?? "5986970093");
const lang = argv.get("lang") ?? "ru";

const BASE = (process.env.WEBAPP_URL ?? "").replace(/\/$/, "");

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`${method} failed: ${json?.description ?? res.status}`);
  return json.result;
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(`Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force.`);
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing: DATABASE_URL is not the local dev DB. Use --force.");
  }
  if (!process.env.BOT_TOKEN || !BASE) throw new Error("Missing BOT_TOKEN / WEBAPP_URL.");

  const { prisma } = await import("@gennety/db");
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { DEFAULT_SESSION } = await import("@gennety/shared");

  const CITY = { homeCityKey: "kyiv", homeCountryCode: "UA", latitude: 50.4501, longitude: 30.5234, timeZone: "Europe/Kyiv" };
  const DOMAIN = "kneu.edu.ua";
  const now = new Date();

  const people = [
    { tg: manTg, key: "man", firstName: "Adrian", gender: "male", preference: "women", age: 28,
      summary: "Warm and takes the lead. Loves cosy cafés, film photography and long, unhurried conversations." },
    { tg: womanTg, key: "woman", firstName: "Sofia", gender: "female", preference: "men", age: 25,
      summary: "Easy-going and expressive; values attention and small gestures. Into books, vintage cars and golden-hour walks." },
  ];

  const ids = {};
  for (const p of people) {
    const data = {
      firstName: p.firstName, gender: p.gender, preference: p.preference, age: p.age,
      language: lang, status: "active", onboardingStep: "completed",
      email: `dev+${p.tg}@${DOMAIN}`, universityDomain: DOMAIN, isEmailVerified: true,
      verificationStatus: "verified", verifiedAt: now,
      hasConsented: true, consentedAt: now, termsAccepted: true, termsAcceptedAt: now,
      lastMessageAt: now,
    };
    if (!apply) { console.log(`[dry-run] would upsert ${p.firstName}`); continue; }
    const user = await prisma.user.upsert({
      where: { telegramId: p.tg },
      update: data,
      create: { telegramId: p.tg, ...data },
      select: { id: true },
    });
    ids[p.key] = user.id;
    await prisma.profile.upsert({
      where: { userId: user.id },
      update: { ...CITY, psychologicalSummary: p.summary },
      create: { userId: user.id, ...CITY, psychologicalSummary: p.summary, photos: [] },
    });
    const sk = String(p.tg);
    const existing = await prisma.botSession.findUnique({ where: { key: sk } });
    await prisma.botSession.upsert({
      where: { key: sk },
      update: { data: { ...DEFAULT_SESSION, ...(existing?.data ?? {}), language: lang } },
      create: { key: sk, data: { ...DEFAULT_SESSION, language: lang } },
    });
    console.log(`✔ seeded ${p.firstName}`);
  }
  if (!apply) { console.log("\n[dry-run] nothing staged. Re-run with --apply."); await prisma.$disconnect(); return; }

  const manId = ids.man;
  const womanId = ids.woman;

  const cancelled = await prisma.match.updateMany({
    where: {
      status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
      OR: [{ userAId: { in: [manId, womanId] } }, { userBId: { in: [manId, womanId] } }],
    },
    data: { status: "cancelled" },
  });
  if (cancelled.count) console.log(`↺ cancelled ${cancelled.count} prior open match(es).`);

  /** Fresh negotiating match (man = side A, exactly like the real accept path). */
  async function newMatch(extra) {
    const m = await createProposedMatch(manId, womanId);
    await prisma.match.update({
      where: { id: m.id },
      data: {
        acceptedByA: true,
        acceptedByB: true,
        status: "negotiating",
        ticketPriceCents: 699,
        ticketExpiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
        ...extra,
      },
    });
    return m.id;
  }

  const paid = new Date();
  const screens = {};

  // ── Ticket gate ───────────────────────────────────────────────────────────
  screens.offer = await newMatch({ ticketStatus: "pending" });
  screens.cover = await newMatch({ ticketStatus: "partial", ticketPaidA: paid });
  screens.waiting = await newMatch({ ticketStatus: "partial", ticketPaidB: paid });
  screens.success = await newMatch({ ticketStatus: "completed", ticketPaidA: paid, ticketPaidB: paid });
  screens.covered = await newMatch({
    ticketStatus: "completed", ticketPaidA: paid, ticketPaidB: paid, paidForPartnerByA: true,
  });
  screens.closed = await newMatch({ ticketStatus: "expired" });

  // ── Calendar: gate passed, slot grid written, SHE already marked slots so the
  //    peer (burgundy) colour and the overlap state are both visible to him. ──
  screens.calendar = await newMatch({ ticketStatus: "completed", ticketPaidA: paid, ticketPaidB: paid });
  const grid = [];
  const day0 = new Date(now);
  day0.setUTCHours(0, 0, 0, 0);
  for (let d = 1; d <= 6; d++) {
    for (const [h, mi] of [[14, 0], [14, 30], [15, 0], [15, 30], [16, 0], [16, 30]]) {
      const slot = new Date(day0);
      slot.setUTCDate(day0.getUTCDate() + d);
      slot.setUTCHours(h, mi, 0, 0);
      grid.push(slot);
    }
  }
  await prisma.match.update({
    where: { id: screens.calendar },
    data: { proposedTimes: grid, availableTimesB: [grid[1], grid[3], grid[8]] },
  });

  // ── Venue board: a scheduled date with a real venue + a future agreed time ──
  screens.venue = await newMatch({ ticketStatus: "completed", ticketPaidA: paid, ticketPaidB: paid });
  const dateAt = new Date(day0);
  dateAt.setUTCDate(day0.getUTCDate() + 1);
  dateAt.setUTCHours(16, 0, 0, 0); // 19:00 Kyiv — cafés are open
  await prisma.match.update({
    where: { id: screens.venue },
    data: {
      status: "scheduled",
      agreedTime: dateAt,
      venueName: "The Blue Cup Coffee Shop",
      venueAddress: "Velyka Vasylkivska St, 23, Kyiv",
      venueLat: 50.4402,
      venueLng: 30.5197,
      venueGoogleMapsUri: "https://maps.google.com/?q=The+Blue+Cup+Coffee+Shop+Kyiv",
    },
  });

  // ── Deliver the menus ─────────────────────────────────────────────────────
  const url = (path, theme) => `${BASE}/${path}${path.includes("?") ? "&" : "?"}lang=${lang}&theme=${theme}`;
  const ticket = (id, theme) => url(`ticket.html?match=${id}`, theme);

  const menus = {
    [String(manTg)]: (theme) => [
      [{ text: "1 · Offer (платит за двоих)", web_app: { url: ticket(screens.offer, theme) } }],
      [{ text: "2 · Cover-partner (докупает ей)", web_app: { url: ticket(screens.cover, theme) } }],
      [{ text: "3 · Success (оба оплатили)", web_app: { url: ticket(screens.success, theme) } }],
      [{ text: "4 · Success «я покрыл её»", web_app: { url: ticket(screens.covered, theme) } }],
      [{ text: "5 · Closed (гейт истёк)", web_app: { url: ticket(screens.closed, theme) } }],
      [{ text: "6 · Календарь (её слоты видны)", web_app: { url: url(`index.html?match=${screens.calendar}`, theme) } }],
      [{ text: "7 · Доска мест", web_app: { url: url(`venue-change.html?match=${screens.venue}`, theme) } }],
      [{ text: "8 · Магазин билетов", web_app: { url: url("tickets.html", theme) } }],
    ],
    [String(womanTg)]: (theme) => [
      [{ text: "1 · Offer (использовать билет)", web_app: { url: ticket(screens.offer, theme) } }],
      [{ text: "2 · Waiting (ждёт его оплаты)", web_app: { url: ticket(screens.waiting, theme) } }],
      [{ text: "3 · Success (оба оплатили)", web_app: { url: ticket(screens.success, theme) } }],
      [{ text: "4 · Partner-paid (он оплатил ей)", web_app: { url: ticket(screens.covered, theme) } }],
      [{ text: "5 · Closed (гейт истёк)", web_app: { url: ticket(screens.closed, theme) } }],
      [{ text: "6 · Календарь (её слоты видны)", web_app: { url: url(`index.html?match=${screens.calendar}`, theme) } }],
      [{ text: "7 · Доска мест", web_app: { url: url(`venue-change.html?match=${screens.venue}`, theme) } }],
      [{ text: "8 · Магазин билетов", web_app: { url: url("tickets.html", theme) } }],
    ],
  };

  for (const [chatId, rows] of Object.entries(menus)) {
    for (const theme of ["dark", "light"]) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: theme === "dark" ? "🌑 QA — ТЁМНАЯ тема" : "☀️ QA — СВЕТЛАЯ тема",
        reply_markup: { inline_keyboard: rows(theme) },
      });
    }
    console.log(`✔ menu sent to ${chatId} (dark + light)`);
  }

  console.log("\n=== STAGED SCREENS ===");
  for (const [k, v] of Object.entries(screens)) console.log(`${k.padEnd(9)} ${v}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
