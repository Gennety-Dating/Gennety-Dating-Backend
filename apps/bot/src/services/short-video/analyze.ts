import type { Language } from "@gennety/shared";
import { sniffImageMime } from "../../utils/image-sniff.js";
import type { ReadMemeResult } from "../vision/read-meme.js";
import type { ShortVideoRef } from "./links.js";
import type { ShortVideoMetadata, ShortVideoMetadataError } from "./metadata.js";

/**
 * Turning a TikTok / Reels link into the same one sentence a sent picture
 * produces (`profiler-image-answer.ts`), for the same cost, without ever
 * downloading the video.
 *
 * The shape is deliberately the twin of `answerProfilerQuestionWithImage`:
 * dependency-injected, never throwing, returning an outcome the router maps to
 * user-facing copy. Everything the two paths produce — a description to store
 * and an optional media pointer to keep with it — is identical by the time it
 * reaches `recordProfilerAnswer`, which is what keeps the Profiler, the
 * icebreaker generator and the §3.12 reveal from needing to know that links
 * exist at all.
 *
 * **Order of operations is the cost design.** The cache is consulted on the
 * platform's own video id, before any network call and before any token is
 * spent, so the tenth person to share a viral reel costs nothing at all. That
 * is the single largest saving available here: on a city-scale product the same
 * clips genuinely do come round again.
 *
 * The cache stores what a public post says about itself plus a pointer we
 * minted — no user is attached to a row, and nothing in it is private. It is
 * emphatically NOT a per-user analysis history.
 */

export type ShortVideoFailure =
  | ShortVideoMetadataError
  /** The vision pass refused the content. */
  | "unsafe"
  /** Metadata was there, but nothing usable came back from it. */
  | "unreadable";

export interface ShortVideoAnalysis {
  ref: ShortVideoRef;
  description: string;
  /** Permanent pointer to the cover frame, when one could be minted. */
  poster: { fileId: string; kind: "photo" } | null;
  /** True when this answer cost nothing — served from a previous analysis. */
  cached: boolean;
}

export type ShortVideoOutcome =
  | ({ ok: true } & ShortVideoAnalysis)
  | { ok: false; error: ShortVideoFailure };

/** What a cache row carries. Deliberately not the Prisma type: this module is
 *  unit-tested without a database. */
export interface ShortVideoCacheEntry {
  description: string;
  posterFileId: string | null;
}

export interface AnalyzeShortVideoDeps {
  /** Follow a share stub to the canonical post, if the ref needs it. */
  resolveRef: (
    ref: ShortVideoRef,
  ) => Promise<{ ok: true; ref: ShortVideoRef } | { ok: false; error: ShortVideoMetadataError }>;
  fetchMetadata: (
    ref: ShortVideoRef,
  ) =>
    | Promise<
        | { ok: true; ref: ShortVideoRef; metadata: ShortVideoMetadata }
        | { ok: false; error: ShortVideoMetadataError }
      >;
  fetchPoster: (
    url: string,
  ) => Promise<{ ok: true; buffer: Buffer } | { ok: false; error: ShortVideoMetadataError }>;
  read: (
    image: { buffer: Buffer; mime: string },
    context: { metadata: ShortVideoMetadata; ref: ShortVideoRef },
  ) => Promise<ReadMemeResult>;
  /** Upload the poster once so the pointer outlives the CDN's signed URL. */
  mintPointer: (poster: Buffer) => Promise<string | null>;
  cacheGet: (ref: ShortVideoRef) => Promise<ShortVideoCacheEntry | null>;
  cacheSet: (
    ref: ShortVideoRef,
    entry: ShortVideoCacheEntry & { authorName: string | null; model: string },
  ) => Promise<void>;
}

export interface AnalyzeShortVideoOptions {
  language: Language;
}

/**
 * Describe one short video from its public metadata and cover frame.
 *
 * `options.language` is carried for the vision pass, which writes the sentence
 * in the sender's language exactly as the image path does — the stored answer
 * must read like something the user could have typed.
 */
export async function analyzeShortVideo(
  ref: ShortVideoRef,
  options: AnalyzeShortVideoOptions,
  deps: AnalyzeShortVideoDeps,
): Promise<ShortVideoOutcome> {
  // A share stub carries no id, so it cannot be looked up — resolving first is
  // what makes `vm.tiktok.com/A` and `tiktok.com/@u/video/123` one cache entry
  // instead of two.
  const resolved = await deps.resolveRef(ref);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  let current = resolved.ref;

  const hit = await deps.cacheGet(current);
  if (hit) {
    return {
      ok: true,
      ref: current,
      description: hit.description,
      poster: hit.posterFileId ? { fileId: hit.posterFileId, kind: "photo" } : null,
      cached: true,
    };
  }

  const meta = await deps.fetchMetadata(current);
  if (!meta.ok) return { ok: false, error: meta.error };
  // Instagram's share URLs only reveal the real shortcode once fetched, so the
  // ref can sharpen here. Re-check the cache against the sharper id before
  // spending a vision call on it.
  if (meta.ref.externalId && meta.ref.externalId !== current.externalId) {
    current = meta.ref;
    const second = await deps.cacheGet(current);
    if (second) {
      return {
        ok: true,
        ref: current,
        description: second.description,
        poster: second.posterFileId
          ? { fileId: second.posterFileId, kind: "photo" }
          : null,
        cached: true,
      };
    }
  }

  const { metadata } = meta;
  if (!metadata.posterUrl) return { ok: false, error: "no_metadata" };

  const poster = await deps.fetchPoster(metadata.posterUrl);
  if (!poster.ok) return { ok: false, error: poster.error };

  // Same rule as the sent-image path: the declared type is whatever the CDN
  // says, the bytes are what we act on. HEIC sniffs fine but the vision
  // endpoint rejects it, so it is "nothing usable" rather than a failed call.
  const mime = sniffImageMime(poster.buffer);
  if (!mime || mime === "image/heic") return { ok: false, error: "unreadable" };

  const described = await deps.read({ buffer: poster.buffer, mime }, {
    metadata,
    ref: current,
  });
  if (!described.ok) {
    // A refusal is not a transport failure: an unsafe cover frame must never
    // become an answer, and must never be cached as one either.
    return { ok: false, error: described.error === "unsafe" ? "unsafe" : "unreadable" };
  }

  // The pointer is a bonus, not a precondition — a description with no pointer
  // is exactly the state a caption-fallback answer is already in, and the offer
  // card knows to skip it.
  const posterFileId = await deps.mintPointer(poster.buffer);

  await deps.cacheSet(current, {
    description: described.description,
    posterFileId,
    authorName: metadata.authorName ?? null,
    model: described.model,
  });

  return {
    ok: true,
    ref: current,
    description: described.description,
    poster: posterFileId ? { fileId: posterFileId, kind: "photo" } : null,
    cached: false,
  };
}
