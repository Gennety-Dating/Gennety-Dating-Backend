import type { Language } from "@gennety/shared";
import { sniffImageMime } from "../utils/image-sniff.js";
import type { ReadMemeResult } from "./vision/read-meme.js";

/**
 * Answering a Profiler question with a picture (PRODUCT_SPEC §Phase 1b).
 *
 * Only questions that declare `acceptsImage` reach here — today the humour one,
 * which asks for a meme in so many words. The image is downloaded, described by
 * a vision pass, and the description is stored as the ordinary answer text.
 *
 * The BYTES are still never persisted (see `vision/read-meme.ts`); what is kept
 * alongside the description is the Telegram `file_id` — a pointer, exactly like
 * `VoicePrompt.telegramFileId`. It costs nothing, it lets the §Phase 4 paid
 * pre-date reveal re-send the real picture instead of paraphrasing it, and it
 * keeps the property that mattered: we are not holding anybody's media.
 *
 * Split out of the router and dependency-injected so the whole decision tree —
 * which media a message actually offers, what happens when vision is down — is
 * unit-testable without Telegram or OpenAI, the same shape
 * `tagAndPersistAppearance` uses. Never throws.
 */

/** Bytes we are willing to base64 into a vision request. Telegram photos are
 *  well under this; a meme sent as an uncompressed document may not be, and a
 *  20 MB file is not worth the tokens when its thumbnail says the same thing. */
export const PROFILER_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/**
 * How a stored `file_id` has to be re-sent. Telegram file_ids are type-tagged —
 * `sendPhoto` with a sticker's id fails outright — and everything that is not a
 * still sticker was captured as a plain JPEG thumbnail, so these two cover the
 * whole space `profilerImageFromMessage` can produce.
 */
export type ProfilerImageKind = "photo" | "sticker";

export interface ProfilerImagePayload {
  fileId: string;
  kind: ProfilerImageKind;
  caption: string | undefined;
}

export type ProfilerImageAnswerOutcome =
  | "recorded"
  | "recorded_caption"
  | "download_failed"
  | "not_an_image"
  | "too_large"
  | "unreadable";

export interface ProfilerImageAnswerDeps {
  download: (fileId: string) => Promise<Buffer | null>;
  read: (
    image: { buffer: Buffer; mime: string },
    caption: string | undefined,
  ) => Promise<ReadMemeResult>;
  /**
   * Persist the resolved text through the ordinary answer path (claim, upsert,
   * advance the batch).
   *
   * `media` is the pointer to keep with it, and is passed ONLY on the path
   * where the description actually came from the picture. A caption fallback
   * deliberately records no pointer: the stored text is then the user's own
   * words about an image we could not read, and pairing it with that image in
   * a paid reveal would be showing something nobody vetted.
   */
  record: (
    text: string,
    media?: { fileId: string; kind: ProfilerImageKind },
  ) => Promise<boolean>;
}

/**
 * The image a message offers, if any.
 *
 * Photos are read at full size. Everything else — a sticker, a GIF, a video,
 * a meme sent as an uncompressed document — is read through its **thumbnail**,
 * which Telegram generates as a plain JPEG. That is what keeps "send me a funny
 * video" from needing a video pipeline: one frame is enough to say what the
 * joke is, and it costs one cheap vision call instead of a decode.
 *
 * Structurally typed rather than taking grammY's `Message` so the rules stay
 * testable with plain objects.
 */
export function profilerImageFromMessage(message: unknown): ProfilerImagePayload | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as {
    caption?: unknown;
    photo?: unknown;
    sticker?: unknown;
    animation?: unknown;
    video?: unknown;
    document?: unknown;
  };
  const caption = typeof msg.caption === "string" && msg.caption.trim() ? msg.caption.trim() : undefined;

  // Largest photo size last — Telegram orders them ascending.
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const fileId = fileIdOf(msg.photo[msg.photo.length - 1]);
    if (fileId) return { fileId, kind: "photo", caption };
  }

  for (const key of ["sticker", "animation", "video", "document"] as const) {
    const media = msg[key];
    if (!media || typeof media !== "object") continue;
    // A static sticker is already a WebP the vision model reads; an animated
    // one (.tgs/.webm) is not, and its thumbnail is. Preferring the thumbnail
    // everywhere but the still sticker keeps one rule instead of a format list.
    const thumb = fileIdOf((media as { thumbnail?: unknown }).thumbnail);
    const own = key === "sticker" && (media as { is_animated?: unknown; is_video?: unknown }).is_animated !== true
      && (media as { is_video?: unknown }).is_video !== true
      ? fileIdOf(media)
      : null;
    // `own` is only ever set for the still-sticker branch, so it is the one
    // case that must be re-sent with `sendSticker`; a thumbnail is a JPEG.
    if (own) return { fileId: own, kind: "sticker", caption };
    if (thumb) return { fileId: thumb, kind: "photo", caption };
  }

  return null;
}

function fileIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const fileId = (value as { file_id?: unknown }).file_id;
  return typeof fileId === "string" && fileId ? fileId : null;
}

/**
 * Download the image, describe it, and record the description as the answer.
 *
 * When the description cannot be had — vision is down, the bytes are not an
 * image we support, the model refused the content — a caption the user sent
 * with the picture is recorded instead. It is their own text, it answers the
 * question as well as anything typed would, and losing it because a vision call
 * timed out would be the worse failure. With no caption to fall back on the
 * caller is told, and the question stays live so the user can simply answer in
 * words (the stall sweep reclaims it if they don't).
 */
export async function answerProfilerQuestionWithImage(
  payload: ProfilerImagePayload,
  language: Language,
  deps: ProfilerImageAnswerDeps,
): Promise<ProfilerImageAnswerOutcome> {
  const fallback = async (outcome: ProfilerImageAnswerOutcome) => {
    if (!payload.caption) return outcome;
    return (await deps.record(payload.caption)) ? "recorded_caption" : outcome;
  };

  const buffer = await deps.download(payload.fileId);
  if (!buffer || buffer.length === 0) return fallback("download_failed");
  if (buffer.length > PROFILER_IMAGE_MAX_BYTES) return fallback("too_large");

  // The declared type is whatever Telegram says; the bytes are what we send.
  // HEIC sniffs fine but the vision endpoint rejects it, so it counts as "not
  // an image" here rather than being sent to fail.
  const mime = sniffImageMime(buffer);
  if (!mime || mime === "image/heic") return fallback("not_an_image");

  const result = await deps.read({ buffer, mime }, payload.caption);
  if (!result.ok) return fallback("unreadable");

  const recorded = await deps.record(result.description, {
    fileId: payload.fileId,
    kind: payload.kind,
  });
  return recorded ? "recorded" : "unreadable";
}
