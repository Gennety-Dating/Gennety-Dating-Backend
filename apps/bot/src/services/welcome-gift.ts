import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Api, InputFile } from "grammy";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";

/**
 * Welcome-gift pre-roll (PRODUCT_SPEC §3.5b).
 *
 * Delivered once, as a pre-roll before a new user's first-ever match pitch
 * (`handlers/matching/pitch.ts`), after `grantWelcomeGiftIfEligible` actually
 * credits the ticket. Two parts:
 *   1. A gender-specific Telegram **video note** (кружок) — a personal note
 *      from the founder. `sendVideoNote` has NO caption field, so it carries
 *      no text; it is pure emotional garnish and is skipped gracefully when no
 *      asset is recorded for the (gender, language) pair.
 *   2. The gift **DM** (`welcomeGiftTicket`) — the substance, carrying the
 *      $6.99 value anchor + an optional message effect.
 *
 * Both parts are best-effort: the ticket is already credited before this runs,
 * so a missing asset, a stale `file_id`, or a Bot API hiccup must never strand
 * the user or block the pitch.
 */

export type WelcomeGiftGender = "male" | "female";

/**
 * In-memory cache of Telegram `file_id`s for the welcome video notes, keyed by
 * `${gender}-${lang}`. The first send uploads the bundled MP4; Telegram returns
 * a `file_id` we reuse for every subsequent send so we never re-upload.
 * Process-local (resets on restart) — self-heals on the next upload.
 */
const videoNoteFileIds = new Map<string, string>();

/** Absolute path to the bundled welcome video note for a (gender, language). */
function welcomeGiftVideoPath(gender: WelcomeGiftGender, lang: Language): string {
  return fileURLToPath(
    new URL(`../assets/welcome-gift/${gender}-${lang}.mp4`, import.meta.url),
  );
}

/**
 * Send the optional founder video note. Uses the `file_id` cache, falls back to
 * uploading the bundled asset, and is a clean no-op when no asset is recorded
 * for the pair (the matrix lights up automatically as operators drop new MP4s
 * into `assets/welcome-gift/`). Never throws.
 */
async function sendWelcomeVideoNote(
  api: Api,
  chatId: number,
  lang: Language,
  gender: WelcomeGiftGender,
): Promise<void> {
  const key = `${gender}-${lang}`;
  try {
    const cached = videoNoteFileIds.get(key);
    let videoNote: string | InputFile | null = cached ?? null;
    if (!videoNote) {
      const path = welcomeGiftVideoPath(gender, lang);
      if (!existsSync(path)) return; // no recorded video note for this pair — skip
      videoNote = new InputFile(path);
    }
    const msg = await api.sendVideoNote(chatId, videoNote);
    const fileId = msg.video_note?.file_id;
    if (fileId && !cached) videoNoteFileIds.set(key, fileId);
  } catch (err) {
    // A stale cached file_id or a transient Bot API error must never block the
    // gift DM — drop the cache entry and fall through to the text-only path.
    videoNoteFileIds.delete(key);
    console.error("[welcome-gift] video note failed:", err);
  }
}

/**
 * Deliver the welcome-gift pre-roll: optional gender video note, then the gift
 * DM with an optional message effect. `gender` may be `null` (legacy rows) —
 * the video note is skipped and only the DM is sent. Best-effort throughout.
 */
export async function sendWelcomeGiftPreroll(
  api: Api,
  chatId: number,
  lang: Language,
  gender: WelcomeGiftGender | null,
): Promise<void> {
  if (gender) {
    await sendWelcomeVideoNote(api, chatId, lang, gender);
  }

  const text = t(lang, "welcomeGiftTicket");
  const effectId = env.MESSAGE_EFFECT_GIFT_ID || undefined;
  try {
    await api.sendMessage(chatId, text, {
      ...(effectId ? { message_effect_id: effectId } : {}),
    });
  } catch {
    // Retry once without the effect so an unsupported effect id never loses the
    // gift notification. The ticket is already credited; My Tickets shows it.
    try {
      await api.sendMessage(chatId, text);
    } catch {
      // ignore
    }
  }
}
