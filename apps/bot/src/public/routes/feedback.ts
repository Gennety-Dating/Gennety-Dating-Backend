import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language, SUPPORTED_LANGUAGES } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { recordPostDateFeedback } from "../../handlers/date/feedback.js";

/**
 * Same UUID guard as the calendar endpoint — Prisma would otherwise throw a
 * synchronous Error on `@db.Uuid` columns when the value is malformed,
 * surfacing as a 500 in the Mini App.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_LANGS: ReadonlySet<Language> = new Set(SUPPORTED_LANGUAGES);
const ALLOWED_SECOND_DATE = new Set(["yes", "maybe", "no"] as const);
type SecondDateAnswer = "yes" | "maybe" | "no";

const MAX_TEXT_LEN = 1000;

interface FeedbackBody {
  matchId?: unknown;
  text?: unknown;
  chemistry?: unknown;
  wantsSecondDate?: unknown;
  language?: unknown;
}

/**
 * Convert the structured Mini App inputs into the single text blob the LLM
 * post-date analyst expects (`parsePostDateFeedbackPrompt`). We don't add
 * new Prisma columns for chemistry / second-date — keeping the row schema
 * untouched is the lower-risk path and the LLM already understands these
 * cues from prose.
 */
function composeFeedbackText(input: {
  text: string;
  chemistry: number;
  wantsSecondDate: SecondDateAnswer;
  language: Language;
}): string {
  const headers: Record<Language, { chem: string; second: string; notes: string; yes: string; maybe: string; no: string }> = {
    en: {
      chem: "Chemistry (1–10)",
      second: "Second date?",
      notes: "Notes",
      yes: "yes",
      maybe: "maybe",
      no: "no",
    },
    ru: {
      chem: "Химия (1–10)",
      second: "Готов(а) на вторую встречу?",
      notes: "Комментарий",
      yes: "да",
      maybe: "может быть",
      no: "нет",
    },
    uk: {
      chem: "Хімія (1–10)",
      second: "Готовий(а) на другу зустріч?",
      notes: "Коментар",
      yes: "так",
      maybe: "можливо",
      no: "ні",
    },
    de: {
      chem: "Chemie (1–10)",
      second: "Zweites Date?",
      notes: "Notizen",
      yes: "ja",
      maybe: "vielleicht",
      no: "nein",
    },
    pl: {
      chem: "Chemia (1–10)",
      second: "Druga randka?",
      notes: "Notatki",
      yes: "tak",
      maybe: "może",
      no: "nie",
    },
  };
  const labels = headers[input.language];
  const secondLabel =
    input.wantsSecondDate === "yes"
      ? labels.yes
      : input.wantsSecondDate === "no"
        ? labels.no
        : labels.maybe;

  return [
    `${labels.chem}: ${input.chemistry}`,
    `${labels.second}: ${secondLabel}`,
    input.text ? `${labels.notes}: ${input.text}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

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

    const body = (req.body ?? {}) as FeedbackBody;

    const matchId = typeof body.matchId === "string" ? body.matchId : null;
    if (!matchId) {
      res.status(400).json({ error: "matchId is required" });
      return;
    }
    if (!UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT_LEN) : "";

    const chemistryRaw = typeof body.chemistry === "number" ? body.chemistry : Number(body.chemistry);
    if (!Number.isFinite(chemistryRaw) || chemistryRaw < 1 || chemistryRaw > 10) {
      res.status(400).json({ error: "chemistry must be an integer 1..10" });
      return;
    }
    const chemistry = Math.round(chemistryRaw);

    const wantsSecondDateRaw = typeof body.wantsSecondDate === "string" ? body.wantsSecondDate : "";
    if (!ALLOWED_SECOND_DATE.has(wantsSecondDateRaw as SecondDateAnswer)) {
      res.status(400).json({ error: "wantsSecondDate must be yes|maybe|no" });
      return;
    }
    const wantsSecondDate = wantsSecondDateRaw as SecondDateAnswer;

    // The form may submit empty `text` if the user only moved the slider /
    // tapped a chip — still a valid signal. Compose the text-blob ourselves.
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(validation.user.id) },
      select: { id: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const langCandidate = typeof body.language === "string" ? body.language : "";
    const language: Language = ALLOWED_LANGS.has(langCandidate as Language)
      ? (langCandidate as Language)
      : ((user.language ?? "en") as Language);

    const composed = composeFeedbackText({
      text,
      chemistry,
      wantsSecondDate,
      language,
    });

    const result = await recordPostDateFeedback({
      userId: user.id,
      matchId,
      text: composed,
      language,
    });

    if (!result.ok) {
      const status =
        result.reason === "match-not-found"
          ? 404
          : result.reason === "not-participant"
            ? 403
            : 400;
      res.status(status).json({ error: result.reason });
      return;
    }

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
