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

/**
 * Resolve the bundled welcome video note for a (gender, language). Tries, in
 * order: a gender+language-specific `<gender>-<lang>.mp4`, a per-language
 * `<lang>.mp4` (same note for both genders of that language), then a single
 * global `default.mp4` (shown to every otherwise-uncovered pair — e.g. `uk`
 * falls back to whatever `default.mp4` holds). Returns the absolute path plus a
 * cache key (the asset basename) so identical assets share one uploaded
 * `file_id`, or `null` when nothing is on disk.
 */
function resolveWelcomeGiftVideo(
  gender: WelcomeGiftGender,
  lang: Language,
): { path: string; key: string } | null {
  const candidates = [`${gender}-${lang}.mp4`, `${lang}.mp4`, "default.mp4"];
  for (const name of candidates) {
    const path = fileURLToPath(
      new URL(`../assets/welcome-gift/${name}`, import.meta.url),
    );
    if (existsSync(path)) return { path, key: name };
  }
  return null;
}

/**
 * Send the optional founder video note. Uses the `file_id` cache, falls back to
 * uploading the bundled asset, and is a clean no-op when no asset is recorded
 * for the pair AND no global `default.mp4` exists (the matrix lights up
 * automatically as operators drop new MP4s into `assets/welcome-gift/`, and a
 * lone `default.mp4` plays for every pair). Never throws.
 */
async function sendWelcomeVideoNote(
  api: Api,
  chatId: number,
  lang: Language,
  gender: WelcomeGiftGender,
): Promise<void> {
  let cacheKey: string | null = null;
  try {
    const asset = resolveWelcomeGiftVideo(gender, lang);
    if (!asset) return; // no specific note and no global default — skip
    cacheKey = asset.key;
    const cached = videoNoteFileIds.get(asset.key);
    const videoNote: string | InputFile = cached ?? new InputFile(asset.path);
    const msg = await api.sendVideoNote(chatId, videoNote);
    const fileId = msg.video_note?.file_id;
    if (fileId && !cached) videoNoteFileIds.set(asset.key, fileId);
  } catch (err) {
    // A stale cached file_id or a transient Bot API error must never block the
    // gift DM — drop the cache entry and fall through to the text-only path.
    if (cacheKey) videoNoteFileIds.delete(cacheKey);
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
