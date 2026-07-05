#!/usr/bin/env node
/**
 * Dev-only helper (local DEP bot only).
 *
 * Gives the two synthetic ticket-demo profiles a real first photo so the ticket
 * Mini App avatars render. For each account it sends a portrait to that chat to
 * mint a bot-owned Telegram `file_id`, deletes the message (keeps the chat
 * clean), and stores the file_id as `Profile.photos[0]`. The ticket photo proxy
 * resolves it via getFile.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-seed-ticket-photos.mjs --apply
 * Optional:
 *   --man-tg=782065541 --woman-tg=5986970093 --force
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
const manTg = argv.get("man-tg") ?? "782065541";
const womanTg = argv.get("woman-tg") ?? "5986970093";

// Stable, public, appropriately-gendered portraits (Unsplash, 512²).
const MAN_PHOTO = "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=512&h=512&fit=crop";
const WOMAN_PHOTO = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=512&h=512&fit=crop";

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  return json.result;
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(`Refusing: expected BOT_USERNAME=gennetytestbot, got ${process.env.BOT_USERNAME}. Use --force.`);
  }
  if (!process.env.DATABASE_URL?.includes("localhost:5434/gennety_dev") && !force) {
    throw new Error("Refusing: DATABASE_URL is not the local localhost:5434/gennety_dev DB. Use --force.");
  }
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN.");

  const { prisma } = await import("@gennety/db");

  const targets = [
    { role: "MAN", tg: manTg, url: MAN_PHOTO },
    { role: "WOMAN", tg: womanTg, url: WOMAN_PHOTO },
  ];

  for (const t of targets) {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(t.tg) },
      select: { id: true, firstName: true },
    });
    if (!user) { console.log(`⚠ ${t.role} tg=${t.tg} not found — skip.`); continue; }
    if (!apply) { console.log(`[dry-run] would set photo for ${t.role} (${user.firstName}) from ${t.url}`); continue; }

    const msg = await tg("sendPhoto", { chat_id: t.tg, photo: t.url });
    const sizes = msg.photo ?? [];
    const fileId = sizes.length ? sizes[sizes.length - 1].file_id : null;
    if (!fileId) throw new Error(`No file_id returned for ${t.role}`);
    // Keep the chat clean — the file_id stays valid after deletion.
    await tg("deleteMessage", { chat_id: t.tg, message_id: msg.message_id }).catch(() => {});

    await prisma.profile.update({ where: { userId: user.id }, data: { photos: [fileId] } });
    console.log(`✔ ${t.role} (${user.firstName}) photo set → file_id ${fileId.slice(0, 18)}…`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
