import type { Language } from "@gennety/shared";
import type { ShortVideoRef } from "./short-video/links.js";
import type { ShortVideoOutcome } from "./short-video/analyze.js";

/**
 * Answering a Profiler question with a TikTok / Reels link.
 *
 * The twin of `profiler-image-answer.ts`, and deliberately the same shape: the
 * decision tree lives here, dependency-injected, so "what happens when the post
 * is private / the platform blocks us / the cover frame is unsafe" is
 * unit-testable without the network. Never throws.
 *
 * **Why this exists at all.** Before it, a link sent as an answer fell through
 * the router's text branch and was stored verbatim: `answerText` became
 * `https://vm.tiktok.com/ZM…`, which the icebreaker generator and the wingman
 * hint then read as if it said something about the person. That was already
 * wrong; adding link support is what makes it right, and the fix is not to
 * store a better string but to store the same kind of sentence a picture
 * produces.
 *
 * **What is recorded, and what is not.** A description that came from the video
 * carries the cover-frame pointer with it, exactly as an image answer carries
 * its `file_id`. Every failure path falls back to the user's OWN words around
 * the link and records no pointer — same rule as the caption fallback: text we
 * could not verify against a picture must never be paired with that picture in
 * a paid reveal. A link sent with no words at all and no readable metadata
 * records nothing, and the question stays live so the user can simply answer
 * in words.
 */

export type ProfilerLinkAnswerOutcome =
  /** Described from the video, pointer kept. */
  | "recorded"
  /** The link was unusable; the user's own words around it were stored. */
  | "recorded_commentary"
  /** Nothing usable and nothing to fall back on — tell the user. */
  | "unavailable";

export interface ProfilerLinkAnswerDeps {
  analyze: (ref: ShortVideoRef, language: Language) => Promise<ShortVideoOutcome>;
  /** Same signature as the image path's `record` — the ordinary answer path,
   *  plus the source URL, which only a link answer can supply. */
  record: (
    text: string,
    media?: { fileId: string; kind: "photo"; sourceUrl?: string },
  ) => Promise<boolean>;
}

export async function answerProfilerQuestionWithLink(
  ref: ShortVideoRef,
  /** Whatever the user typed around the link, if anything. */
  commentary: string | undefined,
  language: Language,
  deps: ProfilerLinkAnswerDeps,
): Promise<ProfilerLinkAnswerOutcome> {
  const fallback = async (): Promise<ProfilerLinkAnswerOutcome> => {
    if (!commentary) return "unavailable";
    return (await deps.record(commentary)) ? "recorded_commentary" : "unavailable";
  };

  const analysis = await deps.analyze(ref, language);
  if (!analysis.ok) return fallback();

  // The source URL rides WITH the pointer, never alone. Without a pointer there
  // is no reveal to attach it to (`memeAnswerFor` requires `memeFileId`), so a
  // bare URL on the row would be dead weight that still names what the user
  // watches.
  const recorded = await deps.record(
    analysis.description,
    analysis.poster ? { ...analysis.poster, sourceUrl: analysis.ref.url } : undefined,
  );
  return recorded ? "recorded" : "unavailable";
}
