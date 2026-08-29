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
/**
 * Held while a whole photo-upload burst is validated in the photo manager.
 * One status for the burst — the per-frame verdicts land together at the end,
 * instead of a "Photo 1/10" reply arriving per frame while later frames are
 * still being checked (which read as the bot spamming/losing track).
 *
 * `frames` picks between two scripts of the SAME length, exactly like
 * {@link photoReviewSteps}: the plural one, and a singular one for a burst that
 * is still a single photo. This surface is where a lone upload is MOST common —
 * it is reached to swap one bad photo, and from the verification gate's
 * "upload different photos" — so the plural was the usual case rather than an
 * edge one. The closing beat says nothing about how many, so both scripts share
 * it; `reviseStatusScript` then leaves it untouched when a burst grows.
 */
export function photoUploadSteps(lang: Language, frames: number): StatusStep[] {
  const many = frames > 1;
  return [
    {
      text: t(lang, many ? "photoUploadStep1" : "photoUploadOneStep1"),
      holdMs: 3000,
      emojiId: AI_EMOJI.spark,
    },
    {
      text: t(lang, many ? "photoUploadStep2" : "photoUploadOneStep2"),
      holdMs: 4000,
      emojiId: AI_EMOJI.spark,
    },
    { text: t(lang, "photoUploadStep3"), holdMs: 4000, emojiId: AI_EMOJI.spark },
  ];
}

/**
 * Held while an ONBOARDING photo burst is validated (the first time the user is
 * asked for photos). Same shape as {@link photoUploadSteps}, different copy: at
 * this point nothing is "uploaded" from the user's side yet — they sent photos
 * and then wait several seconds while each frame goes through vision
 * validation, with only the typing indicator to go on. Two short beats, and —
 * like the photo manager's burst — passed with `until: <batch flush>`, so the
 * shimmer ends the moment the batch settles rather than on a fixed timer.
 *
 * `frames` picks between two scripts of the SAME length: the plural one, and a
 * singular one for a burst that is still a single photo. The burst is often one
 * frame — the stage accepts photos one at a time — and narrating that as "your
 * photos / the shots" reads as the bot having miscounted what it was just sent.
 * Equal length is what lets the caller revise a burst that grows past one frame
 * in place, beat for beat (see `handlePhotoFrame`), so it is asserted by a test.
 */
export function photoReviewSteps(lang: Language, frames: number): StatusStep[] {
  const many = frames > 1;
  return [
    {
      text: t(lang, many ? "photoReviewStep1" : "photoReviewOneStep1"),
      holdMs: 2200,
      emojiId: AI_EMOJI.scan,
    },
    {
      text: t(lang, many ? "photoReviewStep2" : "photoReviewOneStep2"),
      holdMs: 3000,
      emojiId: AI_EMOJI.spark,
    },
  ];
}

/**
 * The held beat over a voice-prompt ingest.
 *
 * Real work runs under both lines — a Bot API download, a Whisper call and a
 * moderation call — so this is narration of something, not a labour illusion.
 * Two beats rather than the video check's three because a 15-second Opus clip
 * is a fraction of the work a profile video is.
 */
/**
 * Hold times for {@link voiceAnswerSteps}. Named, and pinned by a test to a
 * stated ceiling, for the same reason `GENDER_ADVANCE_HOLD_MS` is: this is real
 * time added to the onboarding funnel for every voice answer, and a number like
 * that otherwise creeps one retune at a time.
 */
export const VOICE_ANSWER_LISTEN_HOLD_MS = 3500;
export const VOICE_ANSWER_ANALYSE_HOLD_MS = 2000;

/**
 * Held while an onboarding voice answer is turned into text — the Bot API
 * download plus the Whisper round-trip, which until now ran under a bare
 * `record_voice` chat action while the user waited in silence.
 *
 * Two beats: what the bot is doing to the recording, then what it is doing with
 * what it heard. Passed with `until: <ingest>` and {@link NEVER_CUT_SHORT}, so
 * the script is a script rather than a progress bar: a fast Whisper call cannot
 * collapse it to half of one beat, and a slow one only ever holds the last beat
 * longer. Cost is therefore `max(script, work)`, not their sum.
 *
 * Deliberately distinct from {@link voiceCheckSteps}, which narrates a different
 * job on a neighbouring step: that one validates the §1.3b voice PROMPT (a
 * profile element, kept as audio and never transcribed into the chat), this one
 * covers a recording that is about to be read as an answer.
 */
export function voiceAnswerSteps(lang: Language): StatusStep[] {
  return [
    {
      text: t(lang, "voiceAnswerStep1"),
      holdMs: VOICE_ANSWER_LISTEN_HOLD_MS,
      emojiId: AI_EMOJI.listen,
    },
    {
      text: t(lang, "voiceAnswerStep2"),
      holdMs: VOICE_ANSWER_ANALYSE_HOLD_MS,
      emojiId: AI_EMOJI.think,
    },
  ];
}

export function voiceCheckSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "voiceCheckStep1"), holdMs: 1800, emojiId: AI_EMOJI.listen },
    { text: t(lang, "voiceCheckStep2"), holdMs: 2400, emojiId: AI_EMOJI.spark },
  ];
}

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
 * of dumped instantly.
 *
 * Deliberately **bare**: no `emojiId`, and the labels themselves carry no
 * leading glyph, so the shimmer is a plain thinking line. Holds are half of the
 * original 2500ms — the Profiler runs this beat several times per batch, and at
 * the old pace the pause read as the bot being slow rather than attentive.
 */
export function profilerNextQuestionSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "profilerNextAck"), holdMs: 1200 },
    { text: t(lang, "profilerNextFormulating"), holdMs: 1200 },
  ];
}

/**
 * Shown before the FIRST question of a Profiler batch — it follows a long
 * window pause, not a user answer, so there's nothing to "acknowledge": just
 * the "thinking" shimmer, then the question lands. Same bare, halved treatment
 * as `profilerNextQuestionSteps` (PRODUCT_SPEC §Phase 1b).
 */
export function profilerOpenQuestionSteps(lang: Language): StatusStep[] {
  return [{ text: t(lang, "profilerNextFormulating"), holdMs: 1250 }];
}

/**
 * Shown at a Profiler batch boundary (batch exhausted, more questions pending).
 * Opens on a short generic "thinking" beat, then "saving". The final "saved"
 * line PERSISTS (`deleteAtEnd: false`) — it is the between-batch message, so it
 * carries no thinking icon (it is finalised as a real message, not a shimmer).
 * The two shimmer beats are bare and halved like the in-batch ones.
 */
export function profilerBatchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "profilerBatchThinking"), holdMs: 1000 },
    { text: t(lang, "profilerBatchSaving"), holdMs: 850 },
    { text: t(lang, "profilerBatchSaved"), holdMs: 0 },
  ];
}

/**
 * Shown after a paid Rematch is settled, covering the single-seeker engine run
 * (PRODUCT_SPEC §3.11). THE money-critical wait: he has just paid and is
 * watching an empty chat, and until this existed the most expensive step in the
 * product was visually cheaper than uploading a photo during registration.
 *
 * Two properties make this script different from every other builder here.
 *
 * It runs **at least 10 seconds** (2.2 + 2.4 + 2.6 + 2.8 = 10.0s), and the
 * caller passes {@link NEVER_CUT_SHORT}, so a fast engine run does NOT truncate
 * it — `until` may only ever hold the last beat *longer*. `runRematch` usually
 * answers in a second or two, so most of this is deliberate cover; that is the
 * point, and `analysis-status.test.ts` pins the floor.
 *
 * And **no beat here is a labour illusion**. Real work runs underneath every
 * line: `buildCandidateSql` (city, mutual gender, contact rail, the lifetime
 * pair ban, the candidate cooldown) → embedding + vibe-axis scoring → greedy
 * top-1. That is the opposite of the Type Radar close (`RADAR_THINKING_ENABLED`),
 * which narrates nothing and says so — do not copy this script's confidence to a
 * surface that has not earned it.
 */
export function rematchSearchSteps(lang: Language): StatusStep[] {
  return [
    { text: t(lang, "rematchSearchStep1"), holdMs: 2200, emojiId: AI_EMOJI.scan },
    { text: t(lang, "rematchSearchStep2"), holdMs: 2400, emojiId: AI_EMOJI.matching },
    { text: t(lang, "rematchSearchStep3"), holdMs: 2600, emojiId: AI_EMOJI.vibe },
    { text: t(lang, "rematchSearchStep4"), holdMs: 2800, emojiId: AI_EMOJI.spark },
  ];
}
