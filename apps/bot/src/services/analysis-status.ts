import { t, type Language } from "@gennety/shared";
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
 */
export function venueSearchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "venueSearching"), holdMs: 1200 },
    { text: t(lang, "venueSearchStep2"), holdMs: 1200 },
    { text: t(lang, "venueSearchStep3"), holdMs: 1100 },
  ];
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
