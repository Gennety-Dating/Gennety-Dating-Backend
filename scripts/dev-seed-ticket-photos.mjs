#!/usr/bin/env node
/**
 * Dev-only helper (local DEP bot only).
 *
 * Sets the profile photos for the two ticket-demo accounts so the pitch card
 * and the ticket Mini App avatars render. For each photo it uploads to Telegram
 * (mints a bot-owned file_id), deletes the message (keeps the chat clean), and
 * stores the file_ids as `Profile.photos`. Accepts local file paths (multipart
 * upload) or http(s) URLs; the FIRST photo is used as the ticket avatar.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-seed-ticket-photos.mjs --apply \
 *     --man-photos="/path/a.png,/path/b.png" --woman-photos="/path/c.png,/path/d.png"
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
    const eq = a.indexOf("=");
    return eq === -1 ? [a.slice(2), "true"] : [a.slice(2, eq), a.slice(eq + 1)];
  }),
);
const apply = argv.get("apply") === "true";
const force = argv.get("force") === "true";
const manTg = argv.get("man-tg") ?? "782065541";
const womanTg = argv.get("woman-tg") ?? "5986970093";

const MAN_DEFAULT = "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=512&h=512&fit=crop";
const WOMAN_DEFAULT = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=512&h=512&fit=crop";

const manPhotos = (argv.get("man-photos") ?? MAN_DEFAULT).split(",").map((s) => s.trim()).filter(Boolean);
const womanPhotos = (argv.get("woman-photos") ?? WOMAN_DEFAULT).split(",").map((s) => s.trim()).filter(Boolean);

const API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

async function tgJson(method, payload) {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  return json.result;
}

async function tgForm(method, form) {
  const res = await fetch(`${API()}/${method}`, { method: "POST", body: form });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  return json.result;
}

/** Upload one photo (local path or URL) → return its largest file_id. */
async function uploadPhoto(chatId, ref) {
  let msg;
  if (/^https?:\/\//.test(ref)) {
    msg = await tgJson("sendPhoto", { chat_id: chatId, photo: ref });
  } else {
    if (!existsSync(ref)) throw new Error(`File not found: ${ref}`);
    const buf = readFileSync(ref);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([buf]), "photo.jpg");
    msg = await tgForm("sendPhoto", form);
  }
  const sizes = msg.photo ?? [];
  const fileId = sizes.length ? sizes[sizes.length - 1].file_id : null;
  if (msg.message_id) await tgJson("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
  return fileId;
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
    { role: "MAN", tg: manTg, photos: manPhotos },
    { role: "WOMAN", tg: womanTg, photos: womanPhotos },
  ];

  for (const t of targets) {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(t.tg) },
      select: { id: true, firstName: true },
    });
    if (!user) { console.log(`⚠ ${t.role} tg=${t.tg} not found — skip.`); continue; }
    if (!apply) { console.log(`[dry-run] ${t.role} (${user.firstName}) ← ${t.photos.length} photo(s):`, t.photos); continue; }

    const fileIds = [];
    for (const ref of t.photos) {
      const id = await uploadPhoto(t.tg, ref);
      if (id) fileIds.push(id);
    }
    if (!fileIds.length) throw new Error(`No file_ids minted for ${t.role}`);
    await prisma.profile.update({ where: { userId: user.id }, data: { photos: fileIds } });
    console.log(`✔ ${t.role} (${user.firstName}) ← ${fileIds.length} photo(s); avatar=${fileIds[0].slice(0, 16)}…`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
