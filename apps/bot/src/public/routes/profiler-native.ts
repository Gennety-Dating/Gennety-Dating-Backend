import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import {
  answerNativeProfilerQuestion,
  getNativeProfilerBatch,
  type NativeProfilerBatch,
} from "../../services/profiler-native.js";

/**
 * The Profiler for the NATIVE client (JWT) — PRODUCT_SPEC §Phase 1b.
 *
 *   GET  /v1/me/profiler         — the question to show now (opens a due batch)
 *   POST /v1/me/profiler/answer  — answer, skip, or refuse the live question
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
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!skip && !text) {
      res.status(400).json({ error: "empty_answer" });
      return;
    }

    const result = await answerNativeProfilerQuestion(
      req.userId!,
      questionId,
      skip ? { kind: "skip" } : { kind: "text", text },
    );
    if (!result.ok) {
      // 409, not 404: the question exists, it is just no longer this user's
      // live one — answered in Telegram, expired by the stall sweep, or a
      // double tap. The client re-reads `GET /v1/me/profiler`.
      res.status(409).json({ error: result.error });
      return;
    }
    if (result.outcome === "next") {
      res.json({ outcome: "next", question: result.question, remaining: result.remaining });
      return;
    }
    res.json({ outcome: result.outcome });
  });

  return router;
}

/** Absent keys, never nulls: the Swift client decodes optionals, not unions. */
function serializeBatch(batch: NativeProfilerBatch): Record<string, unknown> {
  if (!batch.question) return {};
  return { question: batch.question, remaining: batch.remaining };
}
