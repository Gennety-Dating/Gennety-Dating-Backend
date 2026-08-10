import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import {
  normaliseFeedback,
  pendingFeedbackFor,
  resolveLanguage,
  submitPostDateFeedback,
  type FeedbackRefusal,
  type PendingFeedbackView,
} from "../../services/post-date-feedback.js";

/**
 * Post-date feedback for the NATIVE client (JWT) — PRODUCT_SPEC §Phase 4.3.
 *
 * The eighth instance of the same hole the ticket gate, the calendar and the
 * proxy chat had, and the widest one yet: the form existed only as a Mini App
 * signed with `initData`, the T+24h prompt that carries its link was a Telegram
 * DM, and `/v1/matches/current` stops returning the match the moment it turns
 * `completed`. An app user was not merely unable to submit — they were never
 * told a form existed, and could not have found it if they had been.
 *
 *   GET  /v1/me/feedback/pending   — the date this user still owes feedback on
 *   POST /v1/me/feedback/post-date — one submission
 *
 * Mounted under `/v1/me` rather than beside the Mini App's `/v1/feedback`
 * because discovery is user-scoped, and because two routers on one prefix
 * would make which-one-answers a question about middleware order.
 *
 * The GET is the part with no Telegram equivalent: there the DM IS the
 * discovery. Everything either surface decides lives in
 * `services/post-date-feedback.ts`; this file maps refusals onto status codes.
 */
export function createNativeFeedbackRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/pending", async (req: Request, res: Response): Promise<void> => {
    const pending = await pendingFeedbackFor(req.userId!);
    // `null` rather than 404: "nothing to answer right now" is the ordinary
    // state of this endpoint, and a client polling it must not have to treat
    // the common case as an error.
    res.json({ pending: pending ? serialize(pending) : null });
  });

  router.post("/post-date", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const matchId = typeof body.matchId === "string" ? body.matchId : null;
    if (!matchId || !UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const normalised = normaliseFeedback(body);
    if (!normalised.ok) {
      answerFailure(res, normalised.error);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { language: true },
    });

    const result = await submitPostDateFeedback({
      userId: req.userId!,
      matchId,
      language: resolveLanguage(body.language, user?.language ?? null),
      submission: normalised.value,
    });
    if (!result.ok) {
      answerFailure(res, result.error);
      return;
    }

    // No thank-you DM here, unlike the Mini App route. That surface can assume
    // a bot chat exists because the request was signed by one; this one cannot,
    // and a message nobody receives is not a confirmation. The 200 is it.
    const pending = await pendingFeedbackFor(req.userId!);
    res.json({ pending: pending ? serialize(pending) : null });
  });

  return router;
}

function serialize(view: PendingFeedbackView): Record<string, unknown> {
  return {
    matchId: view.matchId,
    partnerFirstName: view.partnerFirstName,
    venueName: view.venueName,
    agreedTime: view.agreedTime.toISOString(),
    submitted: view.submitted,
    maxTextLength: view.maxTextLength,
    serverNow: view.serverNow.toISOString(),
  };
}

/**
 * `wrong-state` is 409, not 404: the match exists and the caller is on it —
 * the date simply has not been closed out yet. A 404 would send the client
 * looking for a routing bug that isn't there.
 */
function answerFailure(res: Response, error: FeedbackRefusal): void {
  const status =
    error === "not-participant"
      ? 403
      : error === "wrong-state"
        ? 409
        : error === "match-not-found" || error === "no-pending-feedback"
          ? 404
          : 400;
  res.status(status).json({ error });
}

/** See routes/calendar.ts for why the UUID shape is pre-validated here. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
