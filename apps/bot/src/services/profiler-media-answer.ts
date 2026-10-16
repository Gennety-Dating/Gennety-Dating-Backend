import {
  PROFILER_MAX_ANSWER_LEN,
  profilerQuestionAcceptsImage,
  profilerQuestionById,
  profilerQuestionText,
  type Language,
  type ProfilerAnswerSource,
} from "@gennety/shared";
import { sniffImageMime } from "../utils/image-sniff.js";
import { PROFILER_IMAGE_MAX_BYTES } from "./profiler-image-answer.js";
import type {
  NativeProfilerAnswerResult,
  NativeProfilerReply,
} from "./profiler-native.js";
import type { ReadAnswerVideoOptions } from "./vision/read-answer-video.js";
import type { ReadMemeResult } from "./vision/read-meme.js";
import type { TranscriptionResult } from "./whisper.js";

/**
 * A Profiler answer from the app with media — `POST /v1/me/profiler/answer/media`
 * (PRODUCT_SPEC §Phase 1b). The app shows a «+» and a microphone on every
 * question; this turns what they produced into the same ONE text answer the
 * typed path stores, so every reader of `ProfilerAnswer.answerText` (icebreakers,
 * wingman, wishlist suggestions, admin) perceives the media without learning
 * any new shape:
 *
 *   - a voice note is transcribed (Whisper) — the transcript is the person's
 *     own words, exactly as if typed;
 *   - each photo is described by a vision pass: on the meme questions
 *     (`acceptsImage`) by `readMemeImage`, the very reader the Telegram path
 *     uses; on every other question by `readAnswerPhoto`, which reads the photo
 *     as an answer to that question. A refused (`unsafe`) or unreadable photo
 *     contributes nothing and is never stored.
 *
 * Stored text: typed words, then the transcript, then the photo descriptions.
 * A photo-only answer stores the bare description — the Telegram meme path's
 * form — and a photo beside words is labelled «Photo: …» in the person's
 * language so a reader can tell the two apart.
 *
 * Recording goes through `answerNativeProfilerQuestion` — the same claim and
 * upsert as `/answer` and Telegram, so exactly one answer counts. The photo
 * BYTES that were read are then kept in the chat bucket under the person's
 * own prefix (`{userId}/…`, swept by account deletion's bucket listing);
 * no column points at them (see the route's notes). Dependency-injected so the
 * whole decision tree is testable without OpenAI or Storage. Never throws for
 * a reader / storage failure.
 */

/** Photos one answer may carry. */
export const PROFILER_MEDIA_IMAGES_MAX = 4;

/**
 * Frames of the one video an answer may carry. The app cuts them evenly
 * across the clip (the server has no ffmpeg); six is enough to tell what
 * happens in a short clip and keeps one vision call cheap.
 */
export const PROFILER_MEDIA_VIDEO_FRAMES_MAX = 6;

/** What the vision endpoint takes; GIF and HEIC sniff fine but are refused. */
const ACCEPTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const PHOTO_LABEL: Record<Language, string> = {
  en: "Photo",
  ru: "Фото",
  uk: "Фото",
  de: "Foto",
  pl: "Zdjęcie",
};

const VIDEO_LABEL: Record<Language, string> = {
  en: "Video",
  ru: "Видео",
  uk: "Відео",
  de: "Video",
  pl: "Wideo",
};

/** One read piece of media, as it goes into the stored text. */
export interface MediaDescription {
  kind: "photo" | "video";
  text: string;
}

export interface ProfilerMediaAnswerRequest {
  questionId: string;
  text: string;
  optionIds: string[];
  source?: ProfilerAnswerSource;
  voice?: { buffer: Buffer; mime: string };
  images: Array<{ buffer: Buffer }>;
  /** A video, cut by the app: frames in order, its soundtrack, its length. */
  video?: {
    frames: Array<{ buffer: Buffer }>;
    audio?: { buffer: Buffer; mime: string };
    durationSeconds?: number;
  };
}

export interface ProfilerMediaAnswerDeps {
  /** Live or in «На потом» — checked before any paid call. */
  questionOpen: (userId: string, questionId: string) => Promise<boolean>;
  language: (userId: string) => Promise<Language>;
  transcribe: (buffer: Buffer, options: { mime: string; language: Language }) => Promise<TranscriptionResult>;
  readMeme: (
    image: { buffer: Buffer; mime: string },
    options: { language: Language; caption?: string | undefined },
  ) => Promise<ReadMemeResult>;
  readPhoto: (
    image: { buffer: Buffer; mime: string },
    options: { language: Language; questionText: string; caption?: string | undefined },
  ) => Promise<ReadMemeResult>;
  readVideo: (
    frames: Array<{ buffer: Buffer; mime: string }>,
    options: ReadAnswerVideoOptions,
  ) => Promise<ReadMemeResult>;
  record: (userId: string, questionId: string, reply: NativeProfilerReply) => Promise<NativeProfilerAnswerResult>;
  storeImage: (userId: string, buffer: Buffer, mime: string) => Promise<{ path: string }>;
}

export type ProfilerMediaAnswerOutcome =
  | { ok: true; result: NativeProfilerAnswerResult; storedPaths: string[] }
  | { ok: false; status: 400 | 409 | 413 | 415 | 422 | 503; error: string };

export async function answerProfilerQuestionWithMedia(
  userId: string,
  request: ProfilerMediaAnswerRequest,
  deps: ProfilerMediaAnswerDeps,
): Promise<ProfilerMediaAnswerOutcome> {
  const videoFrames = request.video?.frames ?? [];
  // A soundtrack without a picture is a voice note sent the wrong way.
  if (request.video?.audio && videoFrames.length === 0) {
    return { ok: false, status: 400, error: "missing_video_frames" };
  }
  if (!request.voice && request.images.length === 0 && videoFrames.length === 0) {
    return { ok: false, status: 400, error: "missing_media" };
  }
  if (request.images.length > PROFILER_MEDIA_IMAGES_MAX) {
    return { ok: false, status: 400, error: "too_many_images" };
  }
  if (videoFrames.length > PROFILER_MEDIA_VIDEO_FRAMES_MAX) {
    return { ok: false, status: 400, error: "too_many_video_frames" };
  }

  // The bytes, not the declared type, decide — before anything is spent.
  const images: Array<{ buffer: Buffer; mime: string }> = [];
  for (const image of request.images) {
    const checked = checkedImage(image.buffer);
    if (!checked.ok) return checked;
    images.push(checked.image);
  }
  const frames: Array<{ buffer: Buffer; mime: string }> = [];
  for (const frame of videoFrames) {
    const checked = checkedImage(frame.buffer);
    if (!checked.ok) return checked;
    frames.push(checked.image);
  }

  const question = profilerQuestionById(request.questionId);
  if (!question || !(await deps.questionOpen(userId, request.questionId))) {
    return { ok: false, status: 409, error: "question_not_active" };
  }
  const language = await deps.language(userId);
  const typed = request.text.trim().slice(0, PROFILER_MAX_ANSWER_LEN);

  let transcript = "";
  if (request.voice) {
    const heard = await deps.transcribe(request.voice.buffer, {
      mime: request.voice.mime,
      language,
    });
    // Our outage: the app keeps the note and offers a retry (audit C-06).
    if (!heard.ok && heard.reason === "unavailable") {
      return { ok: false, status: 503, error: "transcription_unavailable" };
    }
    transcript = heard.ok ? heard.text.trim() : "";
    if (!transcript) return { ok: false, status: 422, error: "not_heard" };
  }

  const caption = [typed, transcript].filter(Boolean).join("\n") || undefined;
  const meme = profilerQuestionAcceptsImage(question);
  const questionText = profilerQuestionText(question, language);
  const described: Array<{ description: string; image: { buffer: Buffer; mime: string } }> = [];
  for (const image of images) {
    const read = meme
      ? await deps.readMeme(image, { language, caption })
      : await deps.readPhoto(image, { language, questionText, caption });
    if (read.ok) described.push({ description: read.description, image });
  }

  // The video's soundtrack is what is said IN the clip, not the person's
  // words: a clip of music or silence is still an answer, so a failed or
  // empty transcript only means the picture speaks alone — never a 422/503.
  let video: string | undefined;
  if (frames.length > 0) {
    let soundTranscript: string | undefined;
    if (request.video?.audio) {
      const heard = await deps.transcribe(request.video.audio.buffer, {
        mime: request.video.audio.mime,
        language,
      });
      soundTranscript = heard.ok ? heard.text.trim() || undefined : undefined;
    }
    const read = await deps.readVideo(frames, {
      language,
      questionText,
      meme,
      caption,
      soundTranscript,
      durationSeconds: request.video?.durationSeconds,
    });
    if (read.ok) video = read.description;
  }

  const words = [typed, transcript].filter(Boolean).join("\n\n");
  if (!words && request.optionIds.length === 0 && described.length === 0 && !video) {
    return { ok: false, status: 422, error: "image_unreadable" };
  }

  const text = composeMediaAnswerText(
    words,
    [
      ...described.map((d): MediaDescription => ({ kind: "photo", text: d.description })),
      ...(video ? [{ kind: "video", text: video } satisfies MediaDescription] : []),
    ],
    language,
    request.optionIds.length > 0,
  );
  const result = await deps.record(userId, request.questionId, {
    kind: "text",
    text,
    optionIds: request.optionIds,
    ...(request.source ? { source: request.source } : {}),
    ...(described.length > 0 || video ? { withPhoto: true } : {}),
  });

  // Only a recorded answer keeps its photos: a refused claim stores nothing.
  const storedPaths: string[] = [];
  if (result.ok) {
    for (const { image } of described) {
      try {
        storedPaths.push((await deps.storeImage(userId, image.buffer, image.mime)).path);
      } catch (err) {
        console.warn(
          `[profiler-media] photo upload failed for ${userId}/${request.questionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (storedPaths.length > 0) {
      console.info(`[profiler-media] ${userId}/${request.questionId} photos: ${storedPaths.join(", ")}`);
    }
  }
  return { ok: true, result, storedPaths };
}

/**
 * The bytes of one photo or video frame, sniffed — what the vision endpoint
 * takes, under the profiler image cap. GIF and HEIC are refused: the app
 * converts both to JPEG (an animated GIF arrives as video frames).
 */
function checkedImage(
  buffer: Buffer,
):
  | { ok: true; image: { buffer: Buffer; mime: string } }
  | { ok: false; status: 413 | 415; error: string } {
  if (buffer.length > PROFILER_IMAGE_MAX_BYTES) {
    return { ok: false, status: 413, error: "image_too_large" };
  }
  const mime = sniffImageMime(buffer);
  if (!mime || !ACCEPTED_IMAGE_MIME.has(mime)) {
    return { ok: false, status: 415, error: "unsupported_image" };
  }
  return { ok: true, image: { buffer, mime } };
}

/**
 * Words first, then the photos, then the video. A media-only answer is the
 * bare description (one per line), the form the Telegram meme path stores;
 * beside words — or beside tapped options, which `composeProfilerAnswerText`
 * puts in front — each description is labelled («Photo: …», «Video: …») so a
 * reader knows it is a picture, not a quote. A video beside photos is labelled
 * even without words: two kinds of media must stay apart.
 *
 * Fits `PROFILER_MAX_ANSWER_LEN` without silently dropping every photo: the
 * words give way first, but keep at least half the budget.
 */
export function composeMediaAnswerText(
  words: string,
  descriptions: readonly MediaDescription[],
  language: Language,
  withOptions: boolean,
  maxLength: number = PROFILER_MAX_ANSWER_LEN,
): string {
  if (descriptions.length === 0) return words.slice(0, maxLength);
  const mixed = new Set(descriptions.map((d) => d.kind)).size > 1;
  const labelled = !words && !withOptions && !mixed
    ? descriptions.map((d) => d.text).join("\n")
    : descriptions
        .map((d) => `${(d.kind === "video" ? VIDEO_LABEL : PHOTO_LABEL)[language]}: ${d.text}`)
        .join("\n");
  if (!words) return labelled.slice(0, maxLength);
  const separator = "\n\n";
  const room = Math.max(maxLength - labelled.length - separator.length, Math.floor(maxLength / 2));
  const head = words.slice(0, room);
  return `${head}${separator}${labelled}`.slice(0, maxLength);
}
