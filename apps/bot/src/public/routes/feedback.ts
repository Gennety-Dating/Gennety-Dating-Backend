import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  normaliseFeedback,
  resolveLanguage,
  submitPostDateFeedback,
} from "../../services/post-date-feedback.js";
import { recordMiniAppAction } from "../../services/chat-events.js";

/**
 * Same UUID guard as the calendar endpoint — Prisma would otherwise throw a
 * synchronous Error on `@db.Uuid` columns when the value is malformed,
 * surfacing as a 500 in the Mini App.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mini App post-date feedback endpoint.
 *
 * `POST /v1/feedback/post-date`
 *
 * Auth: `Authorization: tma <initData>` — same convention as the calendar
 * pick endpoint. Lets the Mini App POST without sharing JWT credentials with
 * the Telegram client.
 *
 * Body: `{ matchId, text, chemistry, wantsSecondDate, language? }`. The
 * language hint comes from the URL query (`?lang=`); we trust the bot side
 * picked it from `User.language`. A sketchy / missing value falls through
 * to `User.language` from the DB so the LLM still gets the right hint.
 *
 * The router takes `Api` so we can DM a thank-you confirmation back to the
 * user once the form lands — symmetric with the bot voice path which calls
 * `ctx.reply(feedbackThanks)`.
 */
export function createFeedbackRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.post("/post-date", async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.header("authorization") ?? req.header("Authorization");
    if (!authHeader?.startsWith("tma ")) {
      res.status(401).json({ error: "Missing tma initData" });
      return;
    }
    const initData = authHeader.slice(4).trim();
    if (!initData) {
      res.status(401).json({ error: "Empty initData" });
      return;
    }

    const validation = validateInitData(initData, env.BOT_TOKEN);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid initData", reason: validation.reason });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const matchId = typeof body.matchId === "string" ? body.matchId : null;
    if (!matchId) {
      res.status(400).json({ error: "matchId is required" });
      return;
    }
    if (!UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    // Everything below this line is shared with the native rail
    // (`services/post-date-feedback.ts`). What stays here is only what this
    // surface owns: initData auth, resolving the caller by Telegram id, the
    // Mini App action trail, and the thank-you DM.
    const normalised = normaliseFeedback(body);
    if (!normalised.ok) {
      const status = normalised.error === "bad-chemistry" || normalised.error === "bad-second-date" ? 400 : 400;
      res.status(status).json({ error: normalised.error });
      return;
    }
    const submission = normalised.value;

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(validation.user.id) },
      select: { id: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const language = resolveLanguage(body.language, user.language);

    const result = await submitPostDateFeedback({
      userId: user.id,
      matchId,
      language,
      submission,
    });
    if (!result.ok) {
      const status =
        result.error === "match-not-found"
          ? 404
          : result.error === "not-participant"
            ? 403
            : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    const chemistry = submission.chemistry;
    const wantsSecondDate = submission.wantsSecondDate;

    recordMiniAppAction(
      validation.user.id,
      `in the post-date Feedback Mini App, rated the date ${chemistry}/10 and answered "${wantsSecondDate}" on a second date`,
      { surface: "post_date_feedback", matchId },
    );

    // Confirmation DM — symmetric with the voice path's `ctx.reply`. Best-effort:
    // a 200 to the Mini App is the authoritative success signal.
    api
      .sendMessage(Number(validation.user.id), t(language, "feedbackThanks"))
      .catch((err: unknown) =>
        console.warn(
          `[feedback] thanks DM failed for tg=${validation.user.id}:`,
          err instanceof Error ? err.message : err,
        ),
      );

    res.status(200).json({ ok: true });
  });

  return router;
}
