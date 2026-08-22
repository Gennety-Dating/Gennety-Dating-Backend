#!/usr/bin/env node
/**
 * Seed (or remove) the synthetic test profiles — PRODUCT_SPEC §3.1c.
 *
 *   pnpm tsx scripts/seed-synthetic-profiles.mjs                    # dry run
 *   pnpm tsx scripts/seed-synthetic-profiles.mjs --apply
 *   pnpm tsx scripts/seed-synthetic-profiles.mjs --apply --photos=<dir>
 *   pnpm tsx scripts/seed-synthetic-profiles.mjs --remove --apply
 *
 * These accounts exist to give a real friends-and-family tester an anketa to
 * look at when the real pool has nobody left. They are ordinary users in every
 * respect except the `syntheticAt` marker, which is what keeps them out of the
 * paid Rematch, out of Elo, and out of the admin conversion denominators.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without `--apply` — this writes
 * to whichever database `DATABASE_URL` points at, and for the intended use
 * that is production.
 *
 * ── Photos ────────────────────────────────────────────────────────────────
 * A Telegram `file_id` is minted by SENDING the bytes, and ids are per-bot, so
 * the images must go through the SAME bot that will later show them. The
 * directory is laid out by slot:
 *
 *     <dir>/1/*.jpg   → slot 1
 *     <dir>/2/*.jpg   → slot 2
 *
 * Keep the folder outside the repo — the deploy rsyncs the working tree.
 * `--photos` REPLACES a profile's photo set; without it existing photos are
 * left alone, so editing a bio never blanks someone's pictures.
 *
 * ── Removal ───────────────────────────────────────────────────────────────
 * `--remove` hard-deletes every synthetic account through the production
 * `deleteUserAccount`, the same path a GDPR erasure takes: it cancels live
 * matches, clears the chat session and cascades the relational rows. Run it
 * before the product is opened past the test cohort.
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

// An exported DATABASE_URL beats every dotenv file, so
// `DATABASE_URL=… pnpm tsx …` targets production explicitly. This is the same
// ordering `seed-venues.mjs` was fixed to use after it silently wrote to the
// dev database while reporting success.
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
const apply = args.get("apply") === "true";
const removing = args.get("remove") === "true";
const photosDir = args.get("photos");

const MANIFEST = resolve(root, "scripts/synthetic-profiles.json");
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
/**
 * `MIN_PHOTOS` — a profile under this is not a usable anketa. A hand-kept copy
 * of the shared constant: this script is plain ESM run by `node` and cannot
 * import the TypeScript package, so it must be raised whenever
 * `packages/shared/src/constants.ts` moves. It only warns (a short profile is
 * still seeded), so a drift here costs a missing warning, never a bad write.
 */
const MIN_PHOTOS = 4;

function readImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => IMAGE_EXTS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name));
}

function loadManifest() {
  const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const profiles = raw.profiles ?? [];
  const seen = new Set();
  for (const p of profiles) {
    if (typeof p.slot !== "number" || p.slot < 1) {
      throw new Error(`Profile "${p.firstName}" has an invalid slot: ${p.slot}`);
    }
    // A duplicate slot silently overwrites another profile's account, because
    // the slot IS the telegramId. Cheap to check, expensive to discover later.
    if (seen.has(p.slot)) throw new Error(`Duplicate slot ${p.slot} in the manifest`);
    seen.add(p.slot);
    for (const field of ["firstName", "age", "gender", "preference", "psychologicalSummary"]) {
      if (p[field] === undefined || p[field] === null || p[field] === "") {
        throw new Error(`Profile slot ${p.slot} is missing "${field}"`);
      }
    }
  }
  return profiles;
}

/**
 * A chat the production bot may post into, purely to mint `file_id`s.
 *
 * Prefers `SYNTHETIC_SEED_CHAT_ID`, then the founder's ops chat (this IS the
 * production bot, so unlike the demo seeder that chat is the right one), then
 * any real user. `getUpdates` is not attempted: production is long-polling, so
 * it would 409 every time.
 */
async function resolveUploadChat(prisma) {
  if (process.env.SYNTHETIC_SEED_CHAT_ID) return process.env.SYNTHETIC_SEED_CHAT_ID;
  if (process.env.FOUNDER_TELEGRAM_ID) return process.env.FOUNDER_TELEGRAM_ID;
  const anyUser = await prisma.user.findFirst({
    where: { telegramId: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    select: { telegramId: true },
  });
  return anyUser ? String(anyUser.telegramId) : null;
}

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
  const sizes = body.result.photo;
  return sizes[sizes.length - 1].file_id;
}

function describeTarget() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "unknown";
  return host;
}

async function main() {
  const { prisma } = await import("@gennety/db");
  const { upsertSyntheticProfile, syntheticTelegramId, listSyntheticProfiles } =
    await import("../apps/bot/src/services/synthetic-profiles.js");

  console.log(`Database host: ${describeTarget()}`);
  console.log(apply ? "Mode: APPLY (writes)\n" : "Mode: DRY RUN (no writes)\n");

  if (removing) {
    const existing = await listSyntheticProfiles();
    if (existing.length === 0) {
      console.log("No synthetic profiles in this database. Nothing to remove.");
      await prisma.$disconnect();
      return;
    }
    console.log(`→ ${existing.length} synthetic profile(s) to delete:`);
    for (const u of existing) {
      console.log(`   · ${u.firstName ?? "?"} (${u.gender ?? "?"}, tg ${u.telegramId})`);
    }
    if (!apply) {
      console.log("\nDry run — pass --apply to actually delete.");
      await prisma.$disconnect();
      return;
    }
    const { deleteUserAccount } = await import(
      "../apps/bot/src/services/account-deletion.js"
    );
    for (const u of existing) {
      // `api: null` — a synthetic account has no chat to unpin a banner in,
      // and the partner notifications this service sends after a cancelled
      // match are Telegram/APNs calls the deletion path already tolerates
      // skipping. Storage cleanup still runs; these rows own no objects
      // (Telegram file_ids, not Supabase paths), so it is a no-op.
      const outcome = await deleteUserAccount(u.id, null);
      console.log(
        `   ✓ ${u.firstName ?? u.id}: deleted=${outcome.deleted} ` +
          `cancelledMatches=${outcome.cancelledMatches}`,
      );
    }
    await prisma.$disconnect();
    console.log("\nDone.");
    return;
  }

  const profiles = loadManifest();
  console.log(`→ Manifest: ${profiles.length} profile(s)`);
  const women = profiles.filter((p) => p.gender === "female").length;
  console.log(`   ${women} female / ${profiles.length - women} male\n`);

  if (photosDir) {
    // Reported BEFORE anything is written: a profile seeded without enough
    // photos is active in the pool with an empty anketa, and the tester sees
    // the gap rather than the fix.
    let short = 0;
    for (const p of profiles) {
      const count = readImages(resolve(root, photosDir, String(p.slot))).length;
      if (count === 0) {
        console.log(`   ! slot ${p.slot} (${p.firstName}): no photos in ${photosDir}/${p.slot}`);
        short++;
      } else if (count < MIN_PHOTOS) {
        console.log(`   ! slot ${p.slot} (${p.firstName}): only ${count} photo(s), need ${MIN_PHOTOS}`);
        short++;
      }
    }
    if (short > 0) console.log(`   → ${short} profile(s) below the photo minimum\n`);
  } else {
    console.log("   (no --photos: existing photo sets are left untouched)\n");
  }

  if (!apply) {
    for (const p of profiles) {
      console.log(
        `   · slot ${p.slot} → tg ${syntheticTelegramId(p.slot)} — ` +
          `${p.firstName}, ${p.age}, ${p.gender}, elo ${p.eloScore}`,
      );
    }
    console.log("\nDry run — pass --apply to write.");
    await prisma.$disconnect();
    return;
  }

  const token = process.env.BOT_TOKEN;
  const chatId = photosDir ? await resolveUploadChat(prisma) : null;
  if (photosDir && (!token || !chatId)) {
    console.error(
      "Photo upload needs BOT_TOKEN and a chat to send through.\n" +
        "Set SYNTHETIC_SEED_CHAT_ID, or make sure FOUNDER_TELEGRAM_ID is in the env.",
    );
    process.exit(1);
  }

  for (const p of profiles) {
    const result = await upsertSyntheticProfile(p);
    const tag = result.created ? "created" : "updated";
    const emb = result.embeddingOk ? "" : "  ⚠ embedding NOT built — stays unmatchable";
    console.log(`   ✓ ${p.firstName} (slot ${p.slot}) ${tag}${emb}`);

    if (!photosDir) continue;
    const files = readImages(resolve(root, photosDir, String(p.slot)));
    if (files.length === 0) continue;

    const fileIds = [];
    for (const file of files) {
      fileIds.push(await uploadPhoto(token, chatId, file));
      await new Promise((r) => setTimeout(r, 400)); // well under Telegram's rate limit
    }
    await prisma.profile.update({
      where: { userId: result.userId },
      data: {
        photos: fileIds,
        // Kept strictly 1:1 with `photos` — several readers depend on the
        // `photos[i] ↔ photoFaceScores[i]` alignment, and `profileMedia`
        // normalizes from `photos` when empty.
        photoFaceScores: fileIds.map(() => 1),
        uploadedPhotoHashes: fileIds.map(() => ""),
        acceptedPhotoCount: fileIds.length,
        profileMedia: fileIds.map((photo) => ({ type: "photo", photo })),
      },
    });
    console.log(`     ${fileIds.length} photo(s) uploaded`);
  }

  await prisma.$disconnect();
  console.log(
    "\nDone. The fill pass stays inert until SYNTHETIC_FILL_ENABLED=true.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
