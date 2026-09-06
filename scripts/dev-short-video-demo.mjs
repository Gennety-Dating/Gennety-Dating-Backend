/**
 * Run one TikTok / Reels link through the real short-video pipeline and print
 * what it produced, WITHOUT touching a Profiler question.
 *
 * The full flow is already testable the honest way — `pnpm dev:meme-unlock
 * --ask`, then send a link instead of a picture — but that burns the humour
 * question on every attempt. This is for the loop you actually iterate in:
 * "does this reel produce a sentence worth storing".
 *
 * Nothing here is faked. The metadata is read from the platform's own public
 * endpoints through the same SSRF perimeter the bot uses, the poster is
 * downloaded from the same CDN allowlist, and the description is written by the
 * same vision pass at the same model tier. The one thing it does NOT do by
 * default is mint a Telegram pointer, because that requires sending the cover
 * frame to a chat — pass `--mint=<telegramId>` when you want to exercise that
 * too.
 *
 *   pnpm dev:short-video "https://vm.tiktok.com/ZMabc/"
 *   pnpm dev:short-video "<url>" --lang=ru --no-cache
 *   pnpm dev:short-video "<url>" --mint=782065541
 *
 * Guarded to the dev bot + dev database, like every other dev script here: a
 * pointer minted by the wrong bot is unresolvable, and a cache row written to
 * prod from a laptop is a row nobody can explain later.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `.env.local` overrides `.env`, matching config.ts's own load order.
for (const [file, override] of [
  [".env", false],
  [".env.local", true],
]) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
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

const argv = new Map();
const positional = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split("=");
    argv.set(key, value ?? "true");
  } else {
    positional.push(arg);
  }
}

const target = positional[0];
const lang = argv.get("lang") ?? "en";
const mintTo = argv.get("mint");
const skipCache = argv.get("no-cache") === "true";

if (!target) {
  console.error("Usage: pnpm dev:short-video \"<tiktok or reels url>\" [--lang=ru] [--mint=<tgId>] [--no-cache]");
  process.exit(1);
}
if (process.env.BOT_USERNAME !== "gennetytestbot") {
  throw new Error(
    `Refusing to run: BOT_USERNAME is "${process.env.BOT_USERNAME}", expected "gennetytestbot".`,
  );
}
if (!(process.env.DATABASE_URL ?? "").includes("localhost:5434/gennety_dev")) {
  throw new Error("Refusing to run: DATABASE_URL is not the local dev database.");
}
if (process.env.SHORT_VIDEO_LINKS_ENABLED !== "true") {
  throw new Error("SHORT_VIDEO_LINKS_ENABLED is not 'true' — the feature is off.");
}

// grammy is apps/bot's dependency, not the root's.
const requireFromBot = createRequire(resolve(root, "apps/bot/package.json"));

const { classifyShortVideoUrl } = await import("../apps/bot/src/services/short-video/links.js");
const { analyzeShortVideo } = await import("../apps/bot/src/services/short-video/analyze.js");
const { readShortVideoCache, writeShortVideoCache } = await import(
  "../apps/bot/src/services/short-video/cache.js"
);
const { fetchShortVideoMetadata, resolveShortVideoRef } = await import(
  "../apps/bot/src/services/short-video/metadata.js"
);
const { fetchPosterImage } = await import("../apps/bot/src/services/short-video/safe-fetch.js");
const { mintPosterPointer } = await import(
  "../apps/bot/src/services/short-video/poster-pointer.js"
);
const { readMemeImage } = await import("../apps/bot/src/services/vision/read-meme.js");
const { prisma } = await import("@gennety/db");

const ref = classifyShortVideoUrl(target);
if (!ref) {
  console.error(`Not a TikTok or Instagram Reels link we handle: ${target}`);
  process.exit(1);
}

let api = null;
if (mintTo) {
  const { Bot } = await import(requireFromBot.resolve("grammy"));
  api = new Bot(process.env.BOT_TOKEN).api;
}

const started = Date.now();
const result = await analyzeShortVideo(
  ref,
  { language: lang },
  {
    resolveRef: (candidate) => resolveShortVideoRef(candidate, { timeoutMs: 12_000 }),
    fetchMetadata: (candidate) => fetchShortVideoMetadata(candidate, { timeoutMs: 12_000 }),
    fetchPoster: async (url) => {
      const poster = await fetchPosterImage(url, { timeoutMs: 12_000 });
      return poster.ok ? { ok: true, buffer: poster.buffer } : { ok: false, error: poster.error };
    },
    read: (image, context) =>
      readMemeImage(image, {
        language: lang,
        origin: {
          kind: "short_video",
          platform: context.ref.platform,
          postCaption: context.metadata.caption,
          authorName: context.metadata.authorName,
        },
      }),
    mintPointer: (poster) => (api ? mintPosterPointer(api, Number(mintTo), poster) : Promise.resolve(null)),
    // `--no-cache` forces the full path so a prompt change can be seen; the
    // write still happens, so the next run is warm again.
    cacheGet: skipCache ? async () => null : readShortVideoCache,
    cacheSet: writeShortVideoCache,
  },
);

console.log(
  JSON.stringify(
    { input: target, elapsedMs: Date.now() - started, ...result },
    null,
    2,
  ),
);
if (result.ok && !result.poster && !mintTo) {
  console.log("\nNo pointer: pass --mint=<telegramId> to exercise the upload too.");
}
await prisma.$disconnect();
