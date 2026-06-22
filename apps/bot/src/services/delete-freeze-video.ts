import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Api, InputFile } from "grammy";
import type { Language } from "@gennety/shared";

/**
 * Delete/freeze video note (кружок).
 *
 * Played as the first step when a user taps "Delete Account" in Settings
 * (`handlers/menu/settings.ts`): a personal founder note explaining why freezing
 * is the better move before we surface the Freeze / Delete fork.
 *
 * Same mechanics as the welcome-gift kружок (`services/welcome-gift.ts`):
 *   - `sendVideoNote` has NO caption, so the explanatory text + buttons ride a
 *     separate message after it.
 *   - Best-effort: a missing asset for a language, a stale `file_id`, or a Bot
 *     API hiccup must never strand the user — the caller still sends the
 *     Freeze/Delete buttons.
 *
 * Drop square MP4 video notes (≤ 60s) at
 * `apps/bot/src/assets/delete-freeze/<lang>.mp4` (`en`/`ru`/`uk`/`de`/`pl`).
 */

/**
 * Process-local cache of Telegram `file_id`s keyed by language. The first send
 * uploads the bundled MP4; Telegram returns a `file_id` we reuse afterwards so
 * we never re-upload. Resets on restart, self-heals on the next upload.
 */
const videoNoteFileIds = new Map<string, string>();

/** Absolute path to the bundled delete/freeze video note for a language. */
function deleteFreezeVideoPath(lang: Language): string {
  return fileURLToPath(
    new URL(`../assets/delete-freeze/${lang}.mp4`, import.meta.url),
  );
}

/**
 * Send the delete/freeze founder video note. Uses the `file_id` cache, falls
 * back to uploading the bundled asset, and is a clean no-op when no asset is
 * recorded for the language. Never throws.
 */
export async function sendDeleteFreezeVideoNote(
  api: Api,
  chatId: number,
  lang: Language,
): Promise<void> {
  try {
    const cached = videoNoteFileIds.get(lang);
    let videoNote: string | InputFile | null = cached ?? null;
    if (!videoNote) {
      const path = deleteFreezeVideoPath(lang);
      if (!existsSync(path)) return; // no recorded video note for this language — skip
      videoNote = new InputFile(path);
    }
    const msg = await api.sendVideoNote(chatId, videoNote);
    const fileId = msg.video_note?.file_id;
    if (fileId && !cached) videoNoteFileIds.set(lang, fileId);
  } catch (err) {
    // A stale cached file_id or a transient Bot API error must never block the
    // Freeze/Delete fork — drop the cache entry and fall through.
    videoNoteFileIds.delete(lang);
    console.error("[delete-freeze] video note failed:", err);
  }
}
