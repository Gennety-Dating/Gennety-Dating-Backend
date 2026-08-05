#!/usr/bin/env node
/**
 * Seed the two demo-mode partner profiles, and optionally their photos.
 *
 *   pnpm demo:seed                       # profiles only (idempotent)
 *   pnpm demo:seed -- --photos=./photos  # profiles + upload photos
 *
 * Photos live outside the repo and are uploaded through the DEMO bot, because
 * Telegram `file_id`s are per-bot: production's ids are meaningless to the demo
 * bot and vice versa. Pass a directory laid out as
 *
 *     <dir>/male/*.jpg      → Артём
 *     <dir>/female/*.jpg    → Ева
 *
 * Each image is sent to the founder's own chat with the demo bot (that is the
 * only way to mint a `file_id`), and the resulting ids are written to
 * `Profile.photos`. Re-running with `--photos` REPLACES the photo set; running
 * without it leaves whatever is already there untouched, so a copy tweak in
 * `apps/bot/src/demo/partners.ts` never wipes uploaded images.
 *
 * ⚠️ Run this against the DEMO database. It refuses to run unless
 * DEMO_MODE_ENABLED=true is set in the env it loads.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, extname, join } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
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

// `.env.demo` first so a demo run never picks up production's DATABASE_URL by
// accident. Falls back to the ordinary files for a local demo database.
loadEnvFile(resolve(root, ".env.demo"), true);
loadEnvFile(resolve(root, ".env.local"), false);
loadEnvFile(resolve(root, ".env"), false);

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

if (process.env.DEMO_MODE_ENABLED !== "true") {
  console.error(
    "Refusing to run: DEMO_MODE_ENABLED is not 'true' in the loaded env.\n" +
      "This script writes synthetic users; pointing it at the production\n" +
      "database would put two fake profiles into the real matching pool.\n" +
      "Create .env.demo (see DEMO_MODE.md) and run it again.",
  );
  process.exit(1);
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function readImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => IMAGE_EXTS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name));
}

/** Send a photo through the demo bot and return the `file_id` Telegram assigns. */
async function uploadPhoto(token, chatId, path) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("disable_notification", "true");
  form.append("photo", new Blob([readFileSync(path)]), path.split("/").pop());

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`sendPhoto failed for ${path}: ${body.description}`);
  // Telegram returns every rendered size; the last is the largest.
  const sizes = body.result.photo;
  return sizes[sizes.length - 1].file_id;
}

async function main() {
  const { prisma } = await import("@gennety/db");
  const { DEMO_PARTNERS, seedDemoPartners } = await import(
    "../apps/bot/src/demo/partners.js"
  );

  console.log("→ Seeding demo partner profiles…");
  await seedDemoPartners();
  for (const partner of DEMO_PARTNERS) {
    console.log(`   ✓ ${partner.firstName}, ${partner.age} (${partner.gender})`);
  }

  const photosDir = args.get("photos");
  if (!photosDir) {
    console.log(
      "\nProfiles seeded. Photos left as they are — pass --photos=<dir> to (re)upload.",
    );
    await prisma.$disconnect();
    return;
  }

  const token = process.env.BOT_TOKEN;
  const chatId = process.env.DEMO_SEED_CHAT_ID ?? process.env.FOUNDER_TELEGRAM_ID;
  if (!token || !chatId) {
    console.error(
      "Photo upload needs BOT_TOKEN (the demo bot) and DEMO_SEED_CHAT_ID —\n" +
        "a chat that has pressed Start with the demo bot, so it can send there.",
    );
    process.exit(1);
  }

  for (const partner of DEMO_PARTNERS) {
    const dir = resolve(root, photosDir, partner.gender);
    const files = readImages(dir);
    if (files.length === 0) {
      console.log(`   … no images in ${dir} — leaving ${partner.firstName}'s photos alone`);
      continue;
    }

    console.log(`→ Uploading ${files.length} photo(s) for ${partner.firstName}…`);
    const fileIds = [];
    for (const file of files) {
      fileIds.push(await uploadPhoto(token, chatId, file));
      await new Promise((r) => setTimeout(r, 400)); // stay well under Telegram's rate limit
    }

    const user = await prisma.user.findUnique({
      where: { telegramId: partner.telegramId },
      select: { id: true },
    });
    if (!user) throw new Error(`${partner.firstName} was not seeded`);

    await prisma.profile.update({
      where: { userId: user.id },
      data: {
        photos: fileIds,
        // Kept in lockstep with `photos`: several readers rely on the
        // `photos[i] ↔ photoFaceScores[i]` alignment, and `profileMedia`
        // normalizes from `photos` when empty.
        photoFaceScores: fileIds.map(() => 1),
        uploadedPhotoHashes: fileIds.map(() => ""),
        acceptedPhotoCount: fileIds.length,
        profileMedia: fileIds.map((photo) => ({ type: "photo", photo })),
      },
    });
    console.log(`   ✓ ${partner.firstName}: ${fileIds.length} photo(s)`);
  }

  await prisma.$disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
