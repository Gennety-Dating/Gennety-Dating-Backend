import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import type { StatusStep } from "./ai-stream.js";

/**
 * Builders for the self-replacing "agent is analysing" status sequences
 * rendered by {@link runStatusSequence}. Centralised here so the wording lives
 * in shared i18n and the per-step *timings* stay consistent across the bot.
 *
 * Hold times are deliberately uneven — a mechanical, equal-interval cadence
 * reads as a progress bar, not as thinking. They are language-independent;
 * only the copy is localised.
 */

/**
 * Shown after a user pastes their AI memory dump, before the photo request
 * (`aiMemoryExportPreference = accepted`). Deleted at the end; the real
 * "send your photos" reply lands in its place.
 */
export function profileAnalysisSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "onbAnalyzeStep1"), holdMs: 1500 },
    { text: t(lang, "onbAnalyzeStep2"), holdMs: 2500 },
    { text: t(lang, "onbAnalyzeStep3"), holdMs: 4000 },
  ];
}

/**
 * Shown the moment a user finishes the Persona selfie flow. Outcome-neutral on
 * purpose — the real verified/rejected/review verdict is delivered later by the
 * verification pipeline, so these lines only describe the work in progress.
 */
export function verifyAnalysisSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "verifyAnalyzeStep1"), holdMs: 1800 },
    { text: t(lang, "verifyAnalyzeStep2"), holdMs: 2500 },
    { text: t(lang, "verifyAnalyzeStep3"), holdMs: 3000 },
  ];
}

/**
 * Shown right after a user hard-skips verification, before the "skipped" ack.
 */
export function skipAnalysisSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "skipAnalyzeStep1"), holdMs: 1500 },
    { text: t(lang, "skipAnalyzeStep2"), holdMs: 2500 },
    { text: t(lang, "skipAnalyzeStep3"), holdMs: 3000 },
  ];
}

/**
 * Shown while the concierge picks a venue. Step 1 reuses the existing
 * `venueSearching` copy. Runs concurrently with the real venue lookup so the
 * artificial cadence overlaps real work; deleted before the scheduled card.
 *
 * NB: the venue lookup is usually sub-second, so this remains a cosmetic stub
 * (fixed duration). The genuinely slow step — the date-card PNG render — is
 * covered separately by {@link dateCardSteps}, which is held until the real
 * render resolves rather than running on a timer.
 */
export function venueSearchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "venueSearching"), holdMs: 1200, emojiId: aiEmoji("venue") },
    { text: t(lang, "venueSearchStep2"), holdMs: 1200, emojiId: aiEmoji("route") },
    { text: t(lang, "venueSearchStep3"), holdMs: 1100, emojiId: aiEmoji("sparkle") },
  ];
}

/**
 * Shown while the shareable date-card PNG is rendered (download partner photo +
 * Google Places venue photo + satori→resvg rasterize) — the one genuinely slow
 * beat in finalization. Unlike the other builders this is NOT a stub: it is
 * passed to `runStatusSequence` with `until: <render promise>`, so the last beat
 * is held on screen until the PNG is actually ready, then torn down before the
 * card is sent. Each beat leads with its own AIActions emoji (shine shimmer on
 * the rich path), falling back to the plain glyph. Only runs when
 * `DATE_CARD_FEATURE_ENABLED` (the only path with a real render wait).
 */
export function dateCardSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "dateCardStep1"), holdMs: 1500, emojiId: aiEmoji("confirm") },
    { text: t(lang, "dateCardStep2"), holdMs: 2200, emojiId: aiEmoji("card") },
    { text: t(lang, "dateCardStep3"), holdMs: 2600, emojiId: aiEmoji("sparkle") },
  ];
}

/**
 * Resolve a per-step AIActions custom-emoji id from config. Empty (unset) →
 * undefined, so the step renders its plain leading glyph with no animation
 * (current behaviour until ids are filled in). Only meaningful on the rich path.
 */
function aiEmoji(slot: "route" | "venue" | "confirm" | "card" | "sparkle"): string | undefined {
  const id = {
    route: env.CUSTOM_EMOJI_AI_ROUTE_ID,
    venue: env.CUSTOM_EMOJI_AI_VENUE_ID,
    confirm: env.CUSTOM_EMOJI_AI_CONFIRM_ID,
    card: env.CUSTOM_EMOJI_AI_CARD_ID,
    sparkle: env.CUSTOM_EMOJI_AI_SPARKLE_ID,
  }[slot];
  return id || undefined;
}

/**
 * Shown at a Profiler batch boundary (batch exhausted, more questions pending).
 * The final "saved" line PERSISTS (`deleteAtEnd: false`) — it is the message.
 */
export function profilerBatchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "profilerBatchSaving"), holdMs: 1500 },
    { text: t(lang, "profilerBatchSaved"), holdMs: 0 },
  ];
}
