/**
 * preview-match-pitch — one-shot visual preview of the verified match-pitch
 * card. Sends a synthetic profile to a single Telegram chat using the dev
 * bot. Touches no DB rows.
 *
 * Reproduces the exact ordering the recipient would see in the real flow:
 *   1. Partner photo with `Name, Age\n✓ <Verified>` caption (custom_emoji
 *      entity over `✓` if `CUSTOM_EMOJI_VERIFIED_ID` env is set).
 *   2. A short stand-in pitch text (real flow streams the AI pitch — here we
 *      send one static line so you can focus on the verified affordance).
 *   3. The closing blockquote trust card from the Gennety team — only when
 *      `--verified` is passed.
 *
 * Usage:
 *   pnpm tsx apps/bot/scripts/preview-match-pitch.ts --chat=<telegramId> [flags]
 *
 * Flags:
 *   --chat=<id>         REQUIRED — Telegram chat/user id to receive the preview
 *   --verified          Show the verified badge + trust card (default: off)
 *   --lang=en|ru|uk|de|pl     Caption + trust card language (default: en)
 *   --name=<text>       Partner first name (default: "Alex")
 *   --age=<int>         Partner age (default: 24)
 *   --photo=<url|file_id>   Single photo (default: a public sample portrait)
 *
 * Env required (from .env.local for the dev bot):
 *   BOT_TOKEN                     — @gennetytestbot token
 *   CUSTOM_EMOJI_VERIFIED_ID      (optional) animated checkmark emoji id
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { Api } from "grammy";
import type { MessageEntity } from "grammy/types";
import { t, type Language } from "@gennety/shared";
import { buildPhotoCaption } from "../src/handlers/matching/pitch.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

interface Args {
  chat: number;
  verified: boolean;
  lang: Language;
  name: string;
  age: number;
  photo: string;
}

function parseArgs(): Args {
  const args: Record<string, string | true> = {};
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [k, ...rest] = raw.slice(2).split("=");
    args[k!] = rest.length > 0 ? rest.join("=") : true;
  }
  if (args["help"] || !args["chat"]) {
    console.error(
      [
        "preview-match-pitch — send the verified pitch card to a single Telegram chat.",
        "",
        "Usage:",
        "  pnpm tsx apps/bot/scripts/preview-match-pitch.ts --chat=<id> [--verified] [--lang=en|ru|uk|de|pl]",
        "",
        "Examples:",
        "  pnpm tsx apps/bot/scripts/preview-match-pitch.ts --chat=12345 --verified --lang=ru",
        "  pnpm tsx apps/bot/scripts/preview-match-pitch.ts --chat=12345  # unverified baseline",
      ].join("\n"),
    );
    process.exit(args["help"] ? 0 : 1);
  }
  const chatRaw = String(args["chat"]);
  const chat = Number(chatRaw);
  if (!Number.isFinite(chat)) {
    throw new Error(`--chat must be a numeric Telegram id, got "${chatRaw}"`);
  }
  const langRaw = (args["lang"] === true ? "en" : args["lang"] ?? "en") as string;
  if (langRaw !== "en" && langRaw !== "ru" && langRaw !== "uk" && langRaw !== "de" && langRaw !== "pl") {
    throw new Error(`--lang must be one of en|ru|uk|de|pl, got "${langRaw}"`);
  }
  return {
    chat,
    verified: args["verified"] === true,
    lang: langRaw,
    name: args["name"] === true ? "Alex" : (args["name"] as string | undefined) ?? "Alex",
    age: Number(args["age"] === true ? 24 : args["age"] ?? 24),
    photo:
      args["photo"] === true
        ? "https://picsum.photos/id/64/720/960"
        : (args["photo"] as string | undefined) ?? "https://picsum.photos/id/64/720/960",
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const token = process.env["BOT_TOKEN"];
  if (!token) throw new Error("BOT_TOKEN not set — populate .env.local for the dev bot.");

  const api = new Api(token);
  const customEmojiVerifiedId = process.env["CUSTOM_EMOJI_VERIFIED_ID"] ?? "";

  // 1) Partner photo + caption with optional verified badge.
  const cap = buildPhotoCaption(args.lang, args.name, args.age, {
    verified: args.verified,
    customEmojiVerifiedId,
  });
  const photoOpts: { caption?: string; caption_entities?: MessageEntity[] } = {};
  if (cap.caption) photoOpts.caption = cap.caption;
  if (cap.caption && cap.entities && cap.entities.length > 0) {
    photoOpts.caption_entities = cap.entities;
  }
  await api.sendPhoto(args.chat, args.photo, photoOpts);

  // 2) Stand-in pitch — the real flow streams AI text by editing one message,
  //    but for this preview a single static line keeps the focus on the
  //    verified affordance.
  await api.sendMessage(
    args.chat,
    t(args.lang, "matchHeadline") + "\n\n" + t(args.lang, "matchStreamStart"),
  );

  // 3) Closing trust card — only when previewing the verified branch.
  if (args.verified) {
    const text = t(args.lang, "matchVerifiedQuote");
    await api.sendMessage(args.chat, text, {
      entities: [{ type: "blockquote", offset: 0, length: text.length }],
    });
  }

  console.log(
    `[preview] sent to chat=${args.chat} verified=${args.verified} lang=${args.lang}` +
      (customEmojiVerifiedId ? ` emoji=${customEmojiVerifiedId}` : " emoji=<none>"),
  );
}

main().catch((err) => {
  console.error("[preview] failed:", err);
  process.exit(1);
});
