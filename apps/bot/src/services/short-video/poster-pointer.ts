import { InputFile, type Api, type RawApi } from "grammy";

/**
 * Turn a poster frame we downloaded into a Telegram `file_id`.
 *
 * **Why mint one instead of keeping the CDN URL.** Both platforms sign their
 * poster URLs with an expiry measured in hours. The paid reveal (§3.12 Meme
 * Unlock) fires shortly before a date that was scheduled days earlier, so a
 * stored CDN URL is reliably dead by the time somebody pays to see it — the one
 * failure the refund path exists to avoid, arriving on every single purchase.
 * Uploading once converts an expiring third-party URL into a permanent
 * Telegram-hosted asset, which is what every other pointer in this codebase
 * already is.
 *
 * It also keeps `ProfilerAnswer.memeFileId` meaning exactly one thing. The
 * reveal, the demo guard, the `memeKind` dispatch and the entitlement logic all
 * stay untouched: to everything downstream, a linked reel is a photo answer.
 *
 * **The visible cost.** Minting requires actually sending the photo somewhere,
 * and the only chat we are guaranteed to have is the sender's own. So they see
 * the cover frame appear and vanish. That is their own content, one tap after
 * they sent the link, and the alternative — routing this through an ops chat —
 * would tie a core capture path to `FOUNDER_NOTIFY_ENABLED`, which is off by
 * default and would silently drop the pointer in most deployments.
 *
 * Never throws: a missing pointer degrades to a description-only answer, which
 * is the same state a caption fallback produces and which the offer card
 * already knows to skip.
 */
export async function mintPosterPointer(
  api: Api<RawApi>,
  chatId: number,
  poster: Buffer,
): Promise<string | null> {
  try {
    const message = await api.sendPhoto(
      chatId,
      new InputFile(poster, "cover.jpg"),
      { disable_notification: true },
    );
    // Telegram orders sizes ascending; the last is the full-resolution one,
    // and it is the only one worth keeping — the reveal re-sends this.
    const largest = message.photo?.[message.photo.length - 1];
    // Delete before returning, so a failure to read the id still cleans up.
    await api.deleteMessage(chatId, message.message_id).catch(() => {});
    return largest?.file_id ?? null;
  } catch (err) {
    console.warn("[short-video] poster pointer mint failed", { chatId, err });
    return null;
  }
}
