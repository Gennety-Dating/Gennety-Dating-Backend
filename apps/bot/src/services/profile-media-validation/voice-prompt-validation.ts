import {
  VOICE_PROMPT_MIN_DURATION_SECONDS,
  VOICE_PROMPT_MAX_DURATION_SECONDS,
  VOICE_PROMPT_MAX_FILE_SIZE_BYTES,
} from "@gennety/shared";
import type { MediaValidationResult } from "./types.js";
import { transcriptSharesContactInfo } from "./audio-contact-info.js";
import { transcribeVideoAudio } from "./audio-transcription.js";
import { moderateTextWithOpenAI } from "./openai-moderation.js";
import { combineModerationResults } from "./moderation-policy.js";
import { computeWaveformPeaks } from "./audio-waveform.js";

export interface ValidatedVoicePrompt {
  transcript: string;
  waveform: number[];
}

export interface VoicePromptValidationDeps {
  transcribe: typeof transcribeVideoAudio;
  moderateText: typeof moderateTextWithOpenAI;
  computePeaks: typeof computeWaveformPeaks;
}

const DEFAULT_DEPS: VoicePromptValidationDeps = {
  transcribe: transcribeVideoAudio,
  moderateText: moderateTextWithOpenAI,
  computePeaks: computeWaveformPeaks,
};

/**
 * Safety-only validation, exactly like the profile video: this clip carries no
 * identity gate. It is not compared against the verification selfie and there
 * is no voice-printing anywhere in this product — the audio is checked for what
 * it SAYS, and the transcript is what says it.
 *
 * Ordering is deliberate. The cheap local checks run before anything is sent to
 * a provider, so a mis-held mic button costs nothing. Then transcription, then
 * two independent verdicts on the same text: the ordinary moderation policy,
 * and the contact-info rule that exists only because the medium is audio.
 *
 * A provider that cannot answer is `processing_unavailable` and RETRYABLE, the
 * same fail-closed-but-recoverable posture the photo and video paths take. We
 * decline to publish audio we could not read; we do not tell the user their
 * recording was bad.
 */
export async function validateVoicePrompt(
  args: {
    audio: Buffer;
    durationSeconds: number;
    fileSizeBytes?: number | undefined;
  },
  deps: Partial<VoicePromptValidationDeps> = {},
): Promise<MediaValidationResult<ValidatedVoicePrompt>> {
  const { transcribe, moderateText, computePeaks } = { ...DEFAULT_DEPS, ...deps };

  const reject = (
    reason: Parameters<typeof rejectWith>[0],
    retryable = false,
  ): MediaValidationResult<ValidatedVoicePrompt> => rejectWith(reason, retryable);

  if (args.durationSeconds < VOICE_PROMPT_MIN_DURATION_SECONDS) {
    return reject("voice_too_short", true);
  }
  if (args.durationSeconds > VOICE_PROMPT_MAX_DURATION_SECONDS) {
    return reject("voice_too_long", true);
  }
  if (
    args.fileSizeBytes !== undefined &&
    args.fileSizeBytes > VOICE_PROMPT_MAX_FILE_SIZE_BYTES
  ) {
    return reject("voice_too_long", true);
  }
  if (args.audio.byteLength === 0) return reject("processing_unavailable", true);

  const transcription = await transcribe(args.audio);
  if (!transcription.ok) return reject("processing_unavailable", true);

  const transcript = transcription.text.trim();
  // An empty transcript is not silence-is-fine: the whole safety story rests on
  // reading what was said, so a clip we could not read does not get published.
  if (!transcript) return reject("processing_unavailable", true);

  const moderation = combineModerationResults([await moderateText(transcript)]);
  if (moderation.kind === "unavailable") return reject("processing_unavailable", true);
  if (moderation.kind !== "safe") return reject("unsafe_content");

  if (transcriptSharesContactInfo(transcript)) return reject("audio_contact_info");

  // Best-effort, and last on purpose: a clip that passes every safety check is
  // accepted whether or not ffmpeg could draw its bars.
  const waveform = (await computePeaks(args.audio)) ?? [];

  return { ok: true, value: { transcript, waveform } };
}

function rejectWith(
  reason:
    | "voice_too_short"
    | "voice_too_long"
    | "unsafe_content"
    | "audio_contact_info"
    | "processing_unavailable",
  retryable: boolean,
): MediaValidationResult<ValidatedVoicePrompt> {
  return { ok: false, reason, retryable };
}
