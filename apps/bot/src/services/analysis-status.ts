import { t, type Language } from "@gennety/shared";
import type { StatusStep } from "./ai-stream.js";
import { AI_EMOJI } from "./ai-emoji.js";

/**
 * Builders for the self-replacing "agent is analysing" status sequences
 * rendered by {@link runStatusSequence}. Centralised here so the wording lives
 * in shared i18n and the per-step *timings* + AIActions icon stay consistent
 * across the bot.
 *
 * Hold times are deliberately uneven — a mechanical, equal-interval cadence
 * reads as a progress bar, not as thinking. Each beat leads with a per-step
 * plain text glyph; the AIActions ids are kept for explicit rich-draft demos.
 * Both are language-independent; only the copy is localised.
 */

/**
 * A short standalone "thinking" shimmer shown during the profile survey every
 * few answers, *before* the next question is composed (the typing indicator and
 * generation only start after this is torn down). One beat, held 2.5s, leading
 * with the thinking AIActions glyph. Deleted at the end so the next question
 * lands in its place. Meant to run on the rich path (`rich: true`) so the
 * shimmer + animated emoji render; degrades to a plain edited line otherwise.
 */
export function onboardingThinkingSteps(lang: Language): StatusStep[] {
  return [{ text: t(lang, "onbAnalyzeStep1b"), holdMs: 2500, emojiId: AI_EMOJI.think }];
}

/**
 * Shown after a user pastes their AI memory dump, before the photo request
 * (`aiMemoryExportPreference = accepted`). Deleted at the end; the real
 * "send your photos" reply lands in its place.
 */
export function profileAnalysisSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "onbAnalyzeStep1"), holdMs: 2500, emojiId: AI_EMOJI.scan },
    { text: t(lang, "onbAnalyzeStep1b"), holdMs: 4000, emojiId: AI_EMOJI.think },
    { text: t(lang, "onbAnalyzeStep2"), holdMs: 2500, emojiId: AI_EMOJI.spark },
    { text: t(lang, "onbAnalyzeStep3"), holdMs: 3000, emojiId: AI_EMOJI.spark },
  ];
}

/**
 * Shown the moment a user finishes the Persona selfie flow. Outcome-neutral on
 * purpose — the real verified/rejected/review verdict is delivered later by the
 * verification pipeline, so these lines only describe the work in progress.
 */
export function verifyAnalysisSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "verifyAnalyzeStep1"), holdMs: 1800, emojiId: AI_EMOJI.selfie },
    { text: t(lang, "verifyAnalyzeStep2"), holdMs: 2500, emojiId: AI_EMOJI.craft },
    { text: t(lang, "verifyAnalyzeStep3"), holdMs: 3000, emojiId: AI_EMOJI.spark },
  ];
}

/**
 * Shown while an uploaded profile video is validated (frame sampling +
 * Rekognition face/identity + image/audio moderation + Whisper transcript) —
 * genuinely slow real work, so this is NOT a fixed-duration stub: it is passed
 * to `runStatusSequence` with `until: <validation+pad promise>` and
 * `untilFromStepIndex: 2`, so the first two beats always play as pacing while
 * the work runs in parallel, and the final "last checks" beat is held until the
 * validation (plus a short deliberate pad) settles, then torn down before the
 * verdict lands in its place. Outcome-neutral on purpose — accept/reject is
 * delivered separately after teardown. The opening "reviewing your video" beat
 * leads with the film AIActions glyph; the identity + safety beats reuse the
 * spark animation.
 */
export function videoCheckSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "videoCheckStep1"), holdMs: 2800, emojiId: AI_EMOJI.video },
    { text: t(lang, "videoCheckStep2"), holdMs: 3600, emojiId: AI_EMOJI.spark },
    { text: t(lang, "videoCheckStep3"), holdMs: 2500, emojiId: AI_EMOJI.spark },
  ];
}

/**
 * Shown right after a user hard-skips verification, before the "skipped" ack.
 */
export function skipAnalysisSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "skipAnalyzeStep1"), holdMs: 1500, emojiId: AI_EMOJI.spark },
    { text: t(lang, "skipAnalyzeStep2"), holdMs: 2500, emojiId: AI_EMOJI.spark },
    { text: t(lang, "skipAnalyzeStep3"), holdMs: 3000, emojiId: AI_EMOJI.matching },
  ];
}

/**
 * Shown while the concierge picks a venue. The opening "searching" copy is held
 * twice with a quick icon swap (scan → vibe) before the route/vibe beats — same
 * text, fresh animation — then matches the route and vibe. The caller starts
 * tracking the real venue lookup on the final vibe beat, so the first three
 * beats always play out and the last one is held until the venue is ready;
 * deleted before the scheduled card.
 *
 * NB: the venue lookup is usually sub-second, so the first three beats remain
 * deliberate pacing. The final beat is real progress, held by the caller with
 * `until: <venue promise>` once the lookup needs visible cover.
 */
export function venueSearchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "venueSearching"), holdMs: 3200, emojiId: AI_EMOJI.scan },
    { text: t(lang, "venueSearching"), holdMs: 2000, emojiId: AI_EMOJI.vibe },
    { text: t(lang, "venueSearchStep2"), holdMs: 2500, emojiId: AI_EMOJI.spark },
    { text: t(lang, "venueSearchStep3"), holdMs: 0, emojiId: AI_EMOJI.vibe },
  ];
}

/**
 * Shown while the private date-card PNG is rendered (download partner photo +
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
    { text: t(lang, "dateCardStep1"), holdMs: 1500, emojiId: AI_EMOJI.check },
    { text: t(lang, "dateCardStep2"), holdMs: 2200, emojiId: AI_EMOJI.craft },
    { text: t(lang, "dateCardStep3"), holdMs: 2600, emojiId: AI_EMOJI.craft },
  ];
}

/**
 * Shown while the **shareable** copy of the date card is re-rendered — the
 * partner's face is blurred (AWS Rekognition `DetectFaces` → pixelation) before
 * the card leaves the platform (PRODUCT_SPEC.md §3.7a). The Share tap has no
 * other visible feedback, so without this the user sees nothing for several
 * seconds and may re-tap, stacking renders; the status fires immediately and is
 * held (`until: <render promise>`) until the blurred PNG is ready, then torn
 * down before the card is sent.
 *
 * Beats: prepare (craft) → blur the face (blur) → polish + almost-ready (spark).
 * Hold times are uneven on purpose so the cadence reads as work, not a loop.
 */
export function dateCardShareSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "dateCardShareStep1"), holdMs: 1300, emojiId: AI_EMOJI.craft },
    { text: t(lang, "dateCardShareStep2"), holdMs: 2100, emojiId: AI_EMOJI.blur },
    { text: t(lang, "dateCardShareStep3"), holdMs: 2400, emojiId: AI_EMOJI.spark },
    { text: t(lang, "dateCardShareStep4"), holdMs: 1900, emojiId: AI_EMOJI.spark },
  ];
}

/**
 * Shown between two questions *inside* one Profiler batch — the moment the user
 * answers (or skips) a question and the next one is about to be composed
 * (PRODUCT_SPEC §Phase 1b). A short two-beat thinking line (acknowledge →
 * formulating) that makes the next question feel written *for* the user instead
 * of dumped instantly; deleted at the end so the streamed question lands in its
 * place. Uneven holds so the cadence reads as thinking, not a progress bar.
 */
export function profilerNextQuestionSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "profilerNextAck"), holdMs: 2500, emojiId: AI_EMOJI.accept },
    { text: t(lang, "profilerNextFormulating"), holdMs: 2500, emojiId: AI_EMOJI.think },
  ];
}

/**
 * Shown before the FIRST question of a Profiler batch — it follows a long
 * window pause, not a user answer, so there's nothing to "acknowledge": just
 * the "thinking" shimmer, then the question streams. Keeps every question on the
 * same native compose path (PRODUCT_SPEC §Phase 1b).
 */
export function profilerOpenQuestionSteps(lang: Language): StatusStep[] {
  return [{ text: t(lang, "profilerNextFormulating"), holdMs: 2500, emojiId: AI_EMOJI.think }];
}

/**
 * Shown at a Profiler batch boundary (batch exhausted, more questions pending).
 * Opens on a short generic "thinking" beat, then "saving". The final "saved"
 * line PERSISTS (`deleteAtEnd: false`) — it is the between-batch message, so it
 * carries no thinking icon (it is finalised as a real message, not a shimmer).
 */
export function profilerBatchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "profilerBatchThinking"), holdMs: 2000, emojiId: AI_EMOJI.think },
    { text: t(lang, "profilerBatchSaving"), holdMs: 1700, emojiId: AI_EMOJI.spark },
    { text: t(lang, "profilerBatchSaved"), holdMs: 0 },
  ];
}
