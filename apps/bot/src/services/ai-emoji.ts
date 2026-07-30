/**
 * AIActions custom-emoji ids (https://t.me/addemoji/AIActions) used as the
 * animated leading glyph of each rich `<tg-thinking>` status beat — rendered as
 * `<tg-emoji>` by {@link file://./telegram-rich.ts} and chosen per beat by product.
 *
 * These are opaque Telegram sticker ids. The KEY names describe the status each
 * id leads (its first / primary usage), NOT the glyph's appearance — several
 * beats deliberately reuse the same animation. They are baked in (not env)
 * because they are fixed product choices, not per-deployment config, so a step's
 * icon is one edit here rather than an env var per host.
 *
 * They only render on explicit rich-draft demos. Product status streams use
 * normal message edits, so the step's plain leading text glyph shows instead
 * (see the i18n `*Step*` strings).
 */
export const AI_EMOJI = {
  /** Reading context / scanning. */
  scan: "5537511986251694100",
  /** Sparkle / stars — the recurring "spark" + done beat. */
  spark: "5573473356579078196",
  /** Selfie ↔ photo face-match. */
  selfie: "5535007320238456850",
  /** Reviewing an uploaded profile video. */
  video: "5535138071927848968",
  /** Building / assembling (profile traits, the date card, polishing). */
  craft: "5537727026674270220",
  /** Preparing the user for matching. */
  matching: "5535458420653555733",
  /** Venue vibe / atmosphere. */
  vibe: "5535365052359507996",
  /** Confirming details. */
  check: "5537230721728380949",
  /** Blurring the partner's face for the share copy. */
  blur: "5535333750637854737",
  /** Generic "thinking". */
  think: "5535034915403333642",
  /** Operator-chosen "got it / accepted" glyph (Profiler ack beat). */
  accept: "5537203062138994712",

  /**
   * The five peer-wait tiers (PRODUCT_SPEC §3.6b). One glyph per tier so an
   * hours-long wait does not lead with the same "thinking" cloud from minute one
   * to hour twenty — the icon carries the same escalation the wording does.
   *
   * PENDING OPERATOR PICK: these currently point at existing ids so the ladder
   * is functional, but they were NOT chosen by looking at the animations. Run
   * `scripts/dev/preview-ai-emojis.ts` (numbered preview of all 48 AIActions
   * glyphs) and replace the five ids below with the picks — nothing else needs
   * touching.
   */
  /** Tier 1 (<5m) — handed off to the partner. */
  peerWaitSent: "5537203062138994712",
  /** Tier 2 (5m–1h) — plain waiting. */
  peerWaitWaiting: "5535034915403333642",
  /** Tier 3 (1–6h) — still quiet on their side. */
  peerWaitQuiet: "5537511986251694100",
  /** Tier 4 (6–24h) — we have nudged them. */
  peerWaitNudged: "5535458420653555733",
  /** Tier 5 (>24h) — the §3.5c deadline is closing in. */
  peerWaitDeadline: "5573473356579078196",
} as const;
