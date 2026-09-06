import type { Api, RawApi } from "grammy";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { readMemeImage } from "../vision/read-meme.js";
import { analyzeShortVideo, type ShortVideoOutcome } from "./analyze.js";
import { readShortVideoCache, writeShortVideoCache } from "./cache.js";
import type { ShortVideoRef } from "./links.js";
import { fetchShortVideoMetadata, resolveShortVideoRef } from "./metadata.js";
import { mintPosterPointer } from "./poster-pointer.js";
import { fetchPosterImage } from "./safe-fetch.js";

export {
  commentaryAroundLink,
  findShortVideoLink,
  type ShortVideoPlatform,
  type ShortVideoRef,
} from "./links.js";
export type { ShortVideoOutcome, ShortVideoFailure } from "./analyze.js";

/**
 * Composition root for the short-video path: the one place where the pure
 * pieces (`links`, `metadata`, `analyze`) are wired to the real network, the
 * real database and the real Telegram API.
 *
 * Everything above this line is dependency-injected and tested without any of
 * the three. Keeping the wiring in a single small function is what lets that
 * stay true.
 */
export async function describeShortVideoLink(
  api: Api<RawApi>,
  /** Chat used to mint the cover-frame pointer — see `poster-pointer.ts`. */
  chatId: number,
  ref: ShortVideoRef,
  language: Language,
): Promise<ShortVideoOutcome> {
  const fetchOptions = { timeoutMs: env.SHORT_VIDEO_FETCH_TIMEOUT_MS };

  return analyzeShortVideo(
    ref,
    { language },
    {
      resolveRef: (candidate) => resolveShortVideoRef(candidate, fetchOptions),
      fetchMetadata: (candidate) =>
        fetchShortVideoMetadata(candidate, fetchOptions),
      fetchPoster: async (url) => {
        const result = await fetchPosterImage(url, fetchOptions);
        return result.ok
          ? { ok: true, buffer: result.buffer }
          : { ok: false, error: result.error };
      },
      read: (image, context) =>
        readMemeImage(image, {
          language,
          origin: {
            kind: "short_video",
            platform: context.ref.platform,
            postCaption: context.metadata.caption,
            authorName: context.metadata.authorName,
          },
        }),
      mintPointer: (poster) => mintPosterPointer(api, chatId, poster),
      cacheGet: readShortVideoCache,
      cacheSet: writeShortVideoCache,
    },
  );
}
