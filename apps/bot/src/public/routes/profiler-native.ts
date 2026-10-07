import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import type { ProfilerAnswerSource } from "@gennety/shared";
import {
  answerNativeProfilerQuestion,
  getNativeProfilerBatch,
  type NativeProfilerBatch,
  type NativeProfilerQuestion,
} from "../../services/profiler-native.js";

/**
 * The Profiler for the NATIVE client (JWT) — PRODUCT_SPEC §Phase 1b.
 *
 *   GET  /v1/me/profiler         — the question to show now (opens a due batch)
 *   POST /v1/me/profiler/answer  — answer (typed and/or tapped), skip, refuse,
 *                                  or put off («Позже») the live question; or
 *                                  answer / remove one from «На потом»
 *
 * Until this existed the Profiler was Telegram-only: the worker pushes each
 * batch into the bot chat, and an app-only account (the worker filters on
 * `platform in (telegram, both)`) was never asked at all — so its dates got
 * icebreakers and wingman hints built from nothing. The app pulls instead;
 * every rule lives in `services/profiler-native.ts`, and this file only maps
 * the body and the one refusal onto status codes.
 */
export function createNativeProfilerRouter(): Router {
  const router = Router();
  router.use(requireAuth);

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
  });

  return router;
}

/** More option ids than any input has — the rest is noise, not an answer. */
const MAX_OPTION_IDS = 12;
const SOURCES: readonly ProfilerAnswerSource[] = ["tap", "text", "both"];

/** Absent keys, never nulls: the Swift client decodes optionals, not unions. */
function serializeBatch(batch: NativeProfilerBatch): Record<string, unknown> {
  const later = batch.later?.length ? { later: batch.later.map(serializeQuestion) } : {};
  if (!batch.question) return later;
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
