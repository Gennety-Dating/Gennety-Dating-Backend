import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { shareAskLimiter, shareVideoLimiter } from "../rate-limit.js";
import { usageGuard } from "../usage-middleware.js";
import { readSharedVideo, type ShareVideoReadDeps } from "../../services/share-video/read.js";
import {
  SHARE_ASK_HISTORY_MAX,
  SHARE_ASK_QUESTION_MAX,
  answerShareVideoQuestion,
  type ShareAskDeps,
  type ShareAskTurn,
} from "../../services/share-video/ask.js";
import { addShareInterest } from "../../services/share-video/interest.js";

/**
 * «Поделиться → Gennety» for a short video — the iOS share extension's side
 * (decision journal 2026-10-24).
 *
 *   POST /v1/me/share/video       — a Reel / TikTok / Short → what it is about,
 *                                   one interest, one item or place, questions
 *   POST /v1/me/share/video/ask   — a question about it, answered in the sheet
 *   POST /v1/me/share/interest    — «＋ Интерес»: append one topic to hobbies
 *
 * Behind the same switch as the wishlist (the share sheet is the wishlist's
 * front door): 404 `feature-disabled` while `WISHLIST_FEATURE_ENABLED` is off.
 * An older server without this router answers a bare 404, which the app reads
 * as "not a video" and falls back to the wishlist flow.
 */

const URL_MAX = 2000;

async function viewer(userId: string): Promise<{ language: Language; cityKey: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { language: true, profile: { select: { homeCityKey: true } } },
  });
  return {
    language: (user?.language ?? "en") as Language,
    cityKey: user?.profile?.homeCityKey ?? null,
  };
}

function readUrl(body: Record<string, unknown>): string | null {
  const url = typeof body.url === "string" ? body.url.trim() : "";
  return url && url.length <= URL_MAX ? url : null;
}

function readHistory(raw: unknown): ShareAskTurn[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SHARE_ASK_HISTORY_MAX) return null;
  const turns: ShareAskTurn[] = [];
  for (const entry of raw) {
    const turn = (entry ?? {}) as Record<string, unknown>;
    if (typeof turn.question !== "string" || typeof turn.answer !== "string") return null;
    turns.push({
      question: turn.question.slice(0, SHARE_ASK_QUESTION_MAX),
      answer: turn.answer.slice(0, 1000),
    });
  }
  return turns;
}

export interface ShareRouterDeps {
  read?: ShareVideoReadDeps;
  ask?: ShareAskDeps;
}

export function createShareRouter(deps: ShareRouterDeps = {}): Router {
  const router = Router();
  router.use((_req: Request, res: Response, next): void => {
    if (!env.WISHLIST_FEATURE_ENABLED) {
      res.status(404).json({ error: "feature-disabled" });
      return;
    }
    next();
  });
  router.use(requireAuth);

  router.post("/video", shareVideoLimiter, usageGuard, async (req: Request, res: Response): Promise<void> => {
    const url = readUrl((req.body ?? {}) as Record<string, unknown>);
    if (!url) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    const result = await readSharedVideo(url, await viewer(req.userId!), deps.read);
    if (!result.ok) {
      res.status(400).json({ error: "not-video" });
      return;
    }
    res.json(result.video);
  });

  router.post("/video/ask", shareAskLimiter, usageGuard, async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = readUrl(body);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const history = readHistory(body.history);
    if (!url || !question || question.length > SHARE_ASK_QUESTION_MAX || !history) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    const who = await viewer(req.userId!);
    // Cached for six hours after the sheet's own read, so this is free.
    const read = await readSharedVideo(url, who, deps.read);
    if (!read.ok) {
      res.status(400).json({ error: "not-video" });
      return;
    }
    if (read.video.status === "closed") {
      res.status(422).json({ error: "unreadable" });
      return;
    }
    const answer = await answerShareVideoQuestion(
      { video: read.video, grounding: read.grounding, question, history, ...who },
      deps.ask,
    );
    if (!answer) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    res.json({ answer });
  });

  router.post("/interest", async (req: Request, res: Response): Promise<void> => {
    const result = await addShareInterest(req.userId!, (req.body ?? {}).label);
    if (!result.ok) {
      const status = result.error === "too-many" ? 409 : result.error === "not-found" ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json({ hobbies: result.hobbies, added: result.added });
  });

  return router;
}
