/**
 * Vibe Check — the Shop's personal style picks (decision journal 2026-10-08).
 *
 * The numbers the bot's style-picks agent and its validation share. They live
 * here rather than in the service so the prompt (`ai/prompts.ts`), the
 * validation and the tests read one source.
 */

export const STYLE_CATEGORIES = ["scent", "accents", "grooming"] as const;
export type StyleCategory = (typeof STYLE_CATEGORIES)[number];

export const STYLE_GENDERS = ["men", "women", "unisex"] as const;
export type StyleGender = (typeof STYLE_GENDERS)[number];

/**
 * The tag vocabulary a catalog item may carry. The prefilter overlaps these
 * with tags derived from the person's digest, so a tag outside this list could
 * never match anything — the catalog test refuses it.
 */
export const STYLE_TAGS = [
  // the photo archetype (`type-radar.ts` ARCHETYPES)
  "polished",
  "sporty",
  "urban",
  "creative",
  // tempo (`energyAxis`)
  "calm",
  "energetic",
  // when it is worn
  "evening",
  "daytime",
  // register
  "minimal",
  "statement",
  // temperature (scents mostly)
  "warm",
  "fresh",
] as const;
export type StyleTag = (typeof STYLE_TAGS)[number];

/** How many products the model is shown. */
export const STYLE_SHORTLIST_SIZE = 18;
/** The shortlist holds at least this many of each category (when the catalog has them). */
export const STYLE_SHORTLIST_MIN_PER_CATEGORY = 4;
/** Picks the model is asked for, per category. */
export const STYLE_PICKS_PER_CATEGORY = 2;
/** Fewer valid picks than this and the generation counts as failed. */
export const STYLE_PICKS_MIN_TOTAL = 3;
/** "For you" needs at least this fitScore AND a cited personal signal. */
export const STYLE_FOR_YOU_MIN_SCORE = 85;
/** At most this many "for you" badges per set. */
export const STYLE_FOR_YOU_MAX = 2;
export const STYLE_REASON_MAX_CHARS = 140;
export const STYLE_SIGNAL_MAX_CHARS = 24;
export const STYLE_SIGNALS_MAX = 3;
export const STYLE_BASIS_MAX = 4;
/** A cached set is reused for this long while the digest is unchanged. */
export const STYLE_PICKS_TTL_DAYS = 7;
/** Lifetime of the signed outbound link a pick carries. */
export const STYLE_OUT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bio / summary excerpt cap in the digest. */
export const STYLE_DIGEST_TEXT_MAX_CHARS = 400;
