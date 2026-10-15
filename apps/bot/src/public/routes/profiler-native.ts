import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { requireAuth } from "../auth-middleware.js";
import { voiceLimiter } from "../rate-limit.js";
import type { ProfilerAnswerSource } from "@gennety/shared";
import {
  answerNativeProfilerQuestion,
  getNativeProfilerBatch,
  nativeProfilerQuestionOpen,
  userLanguage,
  type NativeProfilerAnswerResult,
  type NativeProfilerBatch,
  type NativeProfilerQuestion,
} from "../../services/profiler-native.js";
import {
  answerProfilerQuestionWithMedia,
  PROFILER_MEDIA_IMAGES_MAX,
  type ProfilerMediaAnswerDeps,
} from "../../services/profiler-media-answer.js";
import { uploadChatImage } from "../../services/storage.js";
import { readAnswerPhoto } from "../../services/vision/read-answer-photo.js";
import { readMemeImage } from "../../services/vision/read-meme.js";
import { transcribeVoiceResult, WHISPER_MAX_BYTES } from "../../services/whisper.js";
import { MULTIPART_FIELD_LIMITS, multerErrorResponse } from "../../utils/upload-limits.js";

/**
 * The Profiler for the NATIVE client (JWT) — PRODUCT_SPEC §Phase 1b.
 *
 *   GET  /v1/me/profiler         — the question to show now (opens a due batch)
 *   POST /v1/me/profiler/answer  — answer (typed and/or tapped), skip, refuse,
 *                                  or put off («Позже») the live question; or
 *                                  answer / remove one from «На потом»
 *   POST /v1/me/profiler/answer/media — the same answer with a voice note
 *                                  and/or photos (multipart), see
 *                                  `services/profiler-media-answer.ts`
 *
 * Until this existed the Profiler was Telegram-only: the worker pushes each
 * batch into the bot chat, and an app-only account (the worker filters on
 * `platform in (telegram, both)`) was never asked at all — so its dates got
 * icebreakers and wingman hints built from nothing. The app pulls instead;
 * every rule lives in `services/profiler-native.ts`, and this file only maps
 * the body and the one refusal onto status codes.
 */
export function createNativeProfilerRouter(
  mediaDeps: Partial<ProfilerMediaAnswerDeps> = {},
): Router {
  const router = Router();
  router.use(requireAuth);
  const deps: ProfilerMediaAnswerDeps = { ...DEFAULT_MEDIA_DEPS, ...mediaDeps };

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const batch = await getNativeProfilerBatch(req.userId!);
    res.json(serializeBatch(batch));
  });

  router.post("/answer", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    if (!questionId) {
      res.status(400).json({ error: "missing_question_id" });
      return;
    }
    // `skip: true` wins over any text sent beside it — it is the button, and
    // the button is unambiguous.
    const skip = body.skip === true;
    const later = body.later === true;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const optionIds = Array.isArray(body.optionIds)
      ? body.optionIds.filter((id): id is string => typeof id === "string").slice(0, MAX_OPTION_IDS)
      : [];
    const source = SOURCES.find((s) => s === body.source);
    if (!skip && !later && !text && optionIds.length === 0) {
      res.status(400).json({ error: "empty_answer" });
      return;
    }

    const result = await answerNativeProfilerQuestion(
      req.userId!,
      questionId,
      skip
        ? { kind: "skip" }
        : later
          ? { kind: "later" }
          : { kind: "text", text, optionIds, ...(source ? { source } : {}) },
    );
    sendAnswerResult(res, result);
  });

  /**
   * The answer with a voice note (`voice`, 0..1) and/or photos (`images`,
   * 0..`PROFILER_MEDIA_IMAGES_MAX`), beside the same `questionId` / `text` /
   * `optionIds` / `source` as `/answer` as form fields. Same response, same
   * 409. Rate-limited with the chat voice notes: both buy a paid model call.
   */
  router.post(
    "/answer/media",
    voiceLimiter,
    mediaUploadWithErrors,
    async (req: Request, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
      if (!questionId) {
        res.status(400).json({ error: "missing_question_id" });
        return;
      }
      const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
      const voice = files.voice?.[0];
      const outcome = await answerProfilerQuestionWithMedia(
        req.userId!,
        {
          questionId,
          text: typeof body.text === "string" ? body.text : "",
          optionIds: parseOptionIds(body.optionIds ?? body["optionIds[]"]),
          ...(sourceOf(body.source) ? { source: sourceOf(body.source)! } : {}),
          ...(voice ? { voice: { buffer: voice.buffer, mime: voice.mimetype } } : {}),
          images: (files.images ?? []).map((file) => ({ buffer: file.buffer })),
        },
        deps,
      );
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      sendAnswerResult(res, outcome.result);
    },
  );

  return router;
}

/** The `/answer` body and status mapping, shared by the media route. */
function sendAnswerResult(res: Response, result: NativeProfilerAnswerResult): void {
  if (!result.ok) {
    // 409, not 404: the question exists, it is just no longer this user's
    // live one — answered in Telegram, expired by the stall sweep, or a
    // double tap — or «На потом» is full. The client re-reads
    // `GET /v1/me/profiler`. A malformed quick answer is the client's bug: 400.
    const conflict = result.error === "question_not_active" || result.error === "later_full";
    res.status(conflict ? 409 : 400).json({ error: result.error });
    return;
  }
  if (result.outcome === "next") {
    res.json({
      outcome: "next",
      question: serializeQuestion(result.question),
      remaining: result.remaining,
    });
    return;
  }
  res.json({ outcome: result.outcome });
}

const DEFAULT_MEDIA_DEPS: ProfilerMediaAnswerDeps = {
  questionOpen: nativeProfilerQuestionOpen,
  language: userLanguage,
  transcribe: (buffer, options) => transcribeVoiceResult(buffer, options),
  readMeme: (image, options) => readMemeImage(image, options),
  readPhoto: (image, options) => readAnswerPhoto(image, options),
  record: (userId, questionId, reply) => answerNativeProfilerQuestion(userId, questionId, reply),
  storeImage: uploadChatImage,
};

/**
 * One size cap for every part — Whisper's, the larger; a photo over the
 * profiler image cap is refused by the service with its own 413. Too many
 * parts of a kind is multer's `LIMIT_UNEXPECTED_FILE` → 400.
 */
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...MULTIPART_FIELD_LIMITS, fileSize: WHISPER_MAX_BYTES, files: 1 + PROFILER_MEDIA_IMAGES_MAX },
}).fields([
  { name: "voice", maxCount: 1 },
  { name: "images", maxCount: PROFILER_MEDIA_IMAGES_MAX },
]);

function mediaUploadWithErrors(req: Request, res: Response, next: NextFunction): void {
  mediaUpload(req, res, (err: unknown) => {
    if (!err) return next();
    const mapped = multerErrorResponse(err);
    if (mapped) {
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  });
}

/**
 * Option ids from a multipart form: a repeated field (multer gives an array),
 * one field, or a JSON array string. Same cap and filter as `/answer`.
 */
function parseOptionIds(raw: unknown): string[] {
  let values: unknown = raw;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      values = JSON.parse(raw) as unknown;
    } catch {
      values = [];
    }
  }
  const list = Array.isArray(values) ? values : values === undefined ? [] : [values];
  return list
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim())
    .slice(0, MAX_OPTION_IDS);
}

function sourceOf(raw: unknown): ProfilerAnswerSource | undefined {
  return SOURCES.find((s) => s === raw);
}

/** More option ids than any input has — the rest is noise, not an answer. */
const MAX_OPTION_IDS = 12;
const SOURCES: readonly ProfilerAnswerSource[] = ["tap", "text", "both"];

/** Absent keys, never nulls: the Swift client decodes optionals, not unions. */
function serializeBatch(batch: NativeProfilerBatch): Record<string, unknown> {
  const later = batch.later?.length ? { later: batch.later.map(serializeQuestion) } : {};
  const wishlist = batch.wishlist ? { wishlist: batch.wishlist } : {};
  if (!batch.question) return { ...later, ...wishlist };
  return { question: serializeQuestion(batch.question), remaining: batch.remaining, ...later };
}

/**
 * The question and, on a contextual one, its card — dates as ISO instants
 * (the app formats them in the device's own locale and zone), and a venue name
 * or a quoted answer only when there is one.
 */
function serializeQuestion(question: NativeProfilerQuestion): Record<string, unknown> {
  const context = question.context;
  const input = question.input ? { input: question.input } : {};
  if (!context) return { id: question.id, text: question.text, ...input };
  return {
    id: question.id,
    text: question.text,
    ...input,
    context: {
      kind: context.kind,
      dates: context.dates.map((date) => ({
        ...(date.venueName ? { venueName: date.venueName } : {}),
        at: date.at.toISOString(),
      })),
      ...(context.answer
        ? {
            answer: {
              question: context.answer.question,
              text: context.answer.text,
              answeredAt: context.answer.answeredAt.toISOString(),
            },
          }
        : {}),
    },
  };
}
