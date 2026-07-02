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
 *   --photos=<p1,p2,..>  REQUIRED — 1–4 local photo paths, profile order
 *   --out=<dir>          Output directory (default: ./tmp/match-cards)
 *   --variant=<name>     paper | graphite | wine (default: all)
 *   --seed=<text>        Collage jitter seed (default: "preview")
 *   --name=<text>        Inflected display name (default: "Марком")
 *   --tagline=<text>     Hook line (default: synthetic RU sample)
 *   --chat=<telegramId>  ALSO send the paper set to this chat via the dev bot
 *                        (BOT_TOKEN from .env.local) as one protected album —
 *                        eyeball the real Telegram look without seeding a DB.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  renderMatchCard,
  renderMatchCardSet,
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

// Short person-first copy: describe the person and their vibe, never "your
// date with…" framing. Empty eyebrow → the panel opens with the wine accent
// bar instead of words.
const shortTexts: MatchCardTexts = {
  eyebrow: "",
  name: args["name"] ?? "Марк, 20",
  tagline: args["tagline"] ?? "Тёплый, ироничный и очень лёгкий в общении.",
  paragraphs: [
    "Живой ум, слабость к вечерам с хорошим кино и умение делать так, чтобы рядом было спокойно. Настоящий, немного смешной и надёжный — из тех, с кем время летит.",
  ],
  wordmark: "Gennety",
};

// Longer classic copy still drives the graphite/wine alternates.
const classicTexts: MatchCardTexts = {
  eyebrow: "Твоё свидание с",
  name: "Марком",
  tagline: "Марк, 20 — именно то свидание, которое ты искала.",
  paragraphs: [
    "У него живой ум, слабость к вечерам с хорошим фильмом и редкое умение делать так, чтобы рядом было легко. Марк сочетает тепло с иронией: сегодня зовёт гулять по набережной, а завтра — на турнир по настолкам.",
    "Он внимательный без наигранности, знает, чего хочет, и приносит с собой хорошее настроение. Если ищешь кого-то настоящего, немного смешного и надёжного — это твой человек.",
  ],
  wordmark: "Gennety",
};

/** Optional live look: send the rendered set to a chat through the dev bot. */
async function sendSetToChat(cards: Buffer[], chatId: number): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const localEnv = resolve(repoRoot, ".env.local");
  if (existsSync(localEnv)) loadEnv({ path: localEnv });
  const token = process.env.BOT_TOKEN;
  if (!token || Number.isNaN(chatId)) {
    console.error("✗ --chat: need BOT_TOKEN in .env.local and a numeric chat id");
    return;
  }
  const { Api, InputFile } = await import("grammy");
  const api = new Api(token);
  await api.sendMediaGroup(
    chatId,
    cards.map((png, i) => ({
      type: "photo" as const,
      media: new InputFile(png, `match-card-${i + 1}.png`),
      ...(i === 0 ? { caption: "Марк, 20" } : {}),
    })),
    { protect_content: true },
  );
  console.log(`✓ sent ${cards.length}-card album to chat ${chatId} via dev bot`);
}

const variants: MatchCardVariant[] = args["variant"]
  ? [args["variant"] as MatchCardVariant]
  : [...MATCH_CARD_VARIANTS];

for (const variant of variants) {
  const started = Date.now();
  if (variant === "paper") {
    // Paper ships as a SET: lead card (2 photos + text) then photo-only cards.
    const cards = await renderMatchCardSet({
      photos,
      texts: shortTexts,
      seed: args["seed"] ?? "preview",
    });
    if (!cards) {
      console.error("✗ paper: set render returned null");
      continue;
    }
    cards.forEach((png, i) => {
      const file = resolve(outDir, `match-card-paper-${i + 1}.png`);
      writeFileSync(file, png);
      console.log(`✓ paper #${i + 1} → ${file} (${png.length} bytes)`);
    });
    console.log(`  paper set: ${cards.length} card(s), ${Date.now() - started}ms total`);
    if (args["chat"]) await sendSetToChat(cards, Number(args["chat"]));
    continue;
  }
  const png = await renderMatchCard({
    photos,
    texts: classicTexts,
    seed: args["seed"] ?? "preview",
    variant,
  });
  if (!png) {
    console.error(`✗ ${variant}: render returned null`);
    continue;
  }
  const file = resolve(outDir, `match-card-${variant}.png`);
  writeFileSync(file, png);
  console.log(`✓ ${variant} → ${file} (${png.length} bytes, ${Date.now() - started}ms)`);
}
