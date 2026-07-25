#!/usr/bin/env node
// Promo-code campaign management (PROMO_CODES_PRODUCT_SPEC.md). Independent
// reusable codes that grant a new user a Date Ticket + Premium months at the
// onboarding wow screen. Writes to whichever DB `DATABASE_URL` points at — run
// with prod env to manage production codes.
//
//   pnpm promo:create  --code=SUMMER3M --tickets=1 --months=3 --max=500 --expires=2026-09-01 --note="IG campaign"
//   pnpm promo:disable --code=SUMMER3M
//   pnpm promo:stats   --code=SUMMER3M
//   pnpm promo:list
//
// Env loading order is `.env.local` then `.env` (`.env.local` wins), matching
// the app. Codes are stored uppercased and matched case-insensitively.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnv(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(resolve(root, ".env.local"), true);
loadEnv(resolve(root, ".env"), false);

function flag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const command = process.argv[2];
const { prisma } = await import("@gennety/db");

function normalize(code) {
  return String(code).trim().toUpperCase();
}

try {
  if (command === "create") {
    const raw = flag("code");
    if (!raw || raw === true) die("--code=<CODE> is required");
    const code = normalize(raw);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      die("--code must be 3-32 chars of A-Z 0-9 _ - (stored uppercase)");
    }

    const ticketReward = flag("tickets") != null ? Number(flag("tickets")) : Number(process.env.PROMO_DEFAULT_TICKETS ?? 1);
    const premiumMonths = flag("months") != null ? Number(flag("months")) : Number(process.env.PROMO_DEFAULT_PREMIUM_MONTHS ?? 3);
    const maxRaw = flag("max");
    const maxRedemptions = maxRaw == null ? null : Number(maxRaw);
    const expiresRaw = flag("expires");
    const expiresAt = expiresRaw == null ? null : new Date(expiresRaw);
    const note = typeof flag("note") === "string" ? flag("note") : null;

    if (!Number.isInteger(ticketReward) || ticketReward < 0) die("--tickets must be a non-negative integer");
    if (!Number.isInteger(premiumMonths) || premiumMonths < 0) die("--months must be a non-negative integer");
    if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0)) die("--max must be a positive integer");
    if (expiresAt != null && Number.isNaN(expiresAt.getTime())) die("--expires must be a valid date (e.g. 2026-09-01)");

    const row = await prisma.promoCode.upsert({
      where: { code },
      create: { code, ticketReward, premiumMonths, maxRedemptions, expiresAt, note, active: true },
      update: { ticketReward, premiumMonths, maxRedemptions, expiresAt, note, active: true },
    });
    console.log(`✔ promo code ${row.code} ready`);
    console.log(`  reward:  ${row.ticketReward} ticket(s) + ${row.premiumMonths} month(s) Premium`);
    console.log(`  cap:     ${row.maxRedemptions ?? "unlimited"}  (redeemed ${row.redeemedCount})`);
    console.log(`  expires: ${row.expiresAt ? row.expiresAt.toISOString() : "never"}`);
    console.log(`  active:  ${row.active}`);
    console.log(`  link:    t.me/<bot>?start=promo_${row.code}`);
  } else if (command === "disable") {
    const raw = flag("code");
    if (!raw || raw === true) die("--code=<CODE> is required");
    const code = normalize(raw);
    const res = await prisma.promoCode.updateMany({ where: { code }, data: { active: false } });
    if (res.count === 0) die(`no promo code ${code}`);
    console.log(`✔ promo code ${code} disabled (existing grants keep their rewards)`);
  } else if (command === "stats") {
    const raw = flag("code");
    if (!raw || raw === true) die("--code=<CODE> is required");
    const code = normalize(raw);
    const row = await prisma.promoCode.findUnique({
      where: { code },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!row) die(`no promo code ${code}`);
    const recent = await prisma.promoRedemption.findMany({
      where: { promoCodeId: row.id },
      orderBy: { redeemedAt: "desc" },
      take: 10,
      select: { userId: true, redeemedAt: true, ticketsApplied: true, monthsApplied: true },
    });
    console.log(`promo code ${row.code}`);
    console.log(`  active:  ${row.active}   expires: ${row.expiresAt ? row.expiresAt.toISOString() : "never"}`);
    console.log(`  reward:  ${row.ticketReward} ticket(s) + ${row.premiumMonths} month(s)`);
    console.log(`  redeemed: ${row.redeemedCount}${row.maxRedemptions != null ? ` / ${row.maxRedemptions}` : " (unlimited)"}`);
    console.log(`  redemption rows: ${row._count.redemptions}`);
    if (recent.length) {
      console.log(`  last ${recent.length}:`);
      for (const r of recent) {
        console.log(`    ${r.redeemedAt.toISOString()}  user=${r.userId}  +${r.ticketsApplied}t +${r.monthsApplied}m`);
      }
    }
  } else if (command === "list") {
    const rows = await prisma.promoCode.findMany({ orderBy: { createdAt: "desc" } });
    if (!rows.length) {
      console.log("no promo codes");
    } else {
      for (const r of rows) {
        const cap = r.maxRedemptions != null ? `${r.redeemedCount}/${r.maxRedemptions}` : `${r.redeemedCount}/∞`;
        console.log(
          `${r.active ? "●" : "○"} ${r.code.padEnd(16)} ${cap.padEnd(10)} ${r.ticketReward}t+${r.premiumMonths}m` +
            `${r.expiresAt ? `  exp ${r.expiresAt.toISOString().slice(0, 10)}` : ""}${r.note ? `  — ${r.note}` : ""}`,
        );
      }
    }
  } else {
    console.error("usage: promo-codes.mjs <create|disable|stats|list> [--code=...] [--tickets=] [--months=] [--max=] [--expires=] [--note=]");
    process.exit(1);
  }
} finally {
  await prisma.$disconnect();
}
