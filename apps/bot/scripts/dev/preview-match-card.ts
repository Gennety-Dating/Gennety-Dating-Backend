/**
 * preview-match-card — offline visual preview of the collage match-pitch
 * card. Renders every design variant (or one) straight to PNG files from
 * local photos + synthetic pitch copy. No Telegram, no DB, no env needed.
 *
 * Usage:
 *   pnpm tsx apps/bot/scripts/dev/preview-match-card.ts \
 *     --photos=/path/a.jpg,/path/b.jpg[,...] --out=/tmp/cards [flags]
 *
 * Flags:
 *   --photos=<p1,p2,..>  REQUIRED — local photo paths, profile order (slots
 *                        take them by index, so repeats are allowed)
 *   --out=<dir>          Output directory (default: ./tmp/match-cards)
 *   --variant=<name>     paper | graphite | wine | mosaic (default: all)
 *   --seed=<text>        Collage jitter seed (default: "preview")
 *   --name=<text>        Inflected display name (default: "Марком")
 *   --tagline=<text>     Hook line (default: synthetic RU sample)
 *   --cutout=<path>      Alpha-PNG person cutout for the mosaic depth pop
 *   --cutout-slot=<i>    Slot index the cutout belongs to (default: last photo)
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderMatchCard,
  MATCH_CARD_VARIANTS,
  type MatchCardTexts,
  type MatchCardVariant,
} from "../../src/services/match-card/index.js";

const args: Record<string, string> = {};
for (const raw of process.argv.slice(2)) {
  if (!raw.startsWith("--")) continue;
  const [k, ...rest] = raw.slice(2).split("=");
  args[k!] = rest.join("=");
}

if (!args["photos"]) {
  console.error("Usage: preview-match-card.ts --photos=/a.jpg,/b.jpg [--out=dir] [--variant=paper]");
  process.exit(1);
}

const photos = args["photos"]!.split(",").map((p) => readFileSync(resolve(p.trim())));
const outDir = resolve(args["out"] ?? "tmp/match-cards");
mkdirSync(outDir, { recursive: true });

const classicTexts: MatchCardTexts = {
  eyebrow: "Твоё свидание с",
  name: args["name"] ?? "Марком",
  tagline:
    args["tagline"] ??
    "Марк, 20 — именно то свидание, которое ты искала.",
  paragraphs: [
    "У него живой ум, слабость к вечерам с хорошим фильмом и редкое умение делать так, чтобы рядом было легко. Марк сочетает тепло с иронией: сегодня зовёт гулять по набережной, а завтра — на турнир по настолкам.",
    "Он внимательный без наигранности, знает, чего хочет, и приносит с собой хорошее настроение. Если ищешь кого-то настоящего, немного смешного и надёжного — это твой человек.",
  ],
  wordmark: "Gennety",
};

// Mosaic keeps the copy short and describes the person, not "the date".
const mosaicTexts: MatchCardTexts = {
  eyebrow: "Кажется, вы совпадёте",
  name: "Марк, 20",
  tagline: "Тёплый, ироничный и очень лёгкий в общении.",
  paragraphs: [
    "Живой ум, слабость к вечерам с хорошим кино и умение делать так, чтобы рядом было спокойно. Настоящий, немного смешной и надёжный — из тех, с кем время летит.",
  ],
  wordmark: "Gennety",
};

const cutoutPng = args["cutout"] ? readFileSync(resolve(args["cutout"])) : null;
const cutoutSlot = args["cutout-slot"] ? Number(args["cutout-slot"]) : photos.length - 1;

const variants: MatchCardVariant[] = args["variant"]
  ? [args["variant"] as MatchCardVariant]
  : [...MATCH_CARD_VARIANTS];

for (const variant of variants) {
  const started = Date.now();
  const png = await renderMatchCard({
    photos,
    texts: variant === "mosaic" ? mosaicTexts : classicTexts,
    seed: args["seed"] ?? "preview",
    variant,
    cutout: variant === "mosaic" && cutoutPng ? { png: cutoutPng, slotIndex: cutoutSlot } : undefined,
  });
  if (!png) {
    console.error(`✗ ${variant}: render returned null`);
    continue;
  }
  const file = resolve(outDir, `match-card-${variant}.png`);
  writeFileSync(file, png);
  console.log(`✓ ${variant} → ${file} (${png.length} bytes, ${Date.now() - started}ms)`);
}
