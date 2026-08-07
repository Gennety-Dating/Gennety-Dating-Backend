import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import {
  readProxyChat,
  relayProxyMessage,
  type ProxyChatRefusal,
  type ProxyChatView,
} from "../../services/proxy-chat.js";
import { PROXY_MAX_MESSAGE_LEN } from "@gennety/shared";

/**
 * Anonymous pre-date chat for the NATIVE client (JWT) — PRODUCT_SPEC §Phase 4.
 *
 * The third instance of the same hole the ticket gate and the calendar had: the
 * proxy relay existed only as a Telegram chat session, so an app user could not
 * read a message their partner sent, let alone answer one. Worse than those
 * two, because the window is thirty minutes wide and exists precisely for the
 * person standing outside a venue looking for someone.
 *
 *   GET  /v1/matches/:id/chat  — window state + messages (`?since=` for a delta)
 *   POST /v1/matches/:id/chat  — relay one text message
 *
 * Both answer the same shape so a send needs no follow-up read. Every decision
 * — is the window open, what gets logged, how the partner is reached — belongs
 * to `services/proxy-chat.ts` and is shared with the Telegram relay; this file
 * only maps refusals onto status codes.
 */
export function createProxyChatRouter(): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    // `exactOptionalPropertyTypes` — an absent cursor means "the whole
    // window", which is not the same statement as `since: undefined`.
    const since = typeof req.query.since === "string" ? req.query.since : null;
    const result = await readProxyChat({
      matchId,
      userId: req.userId!,
      ...(since ? { since } : {}),
    });
    if (!result.ok) {
      answerFailure(res, result.error);
      return;
    }
    res.json(serialize(result.view));
  });

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== "string") {
      res.status(400).json({ error: "body-required" });
      return;
    }
    // Refused rather than truncated: a message silently cut in half is worse
    // than one the sender is told to shorten, and the ceiling is served to the
    // client as `maxMessageLength` so a well-behaved one never reaches here.
    if (body.length > PROXY_MAX_MESSAGE_LEN) {
      res.status(400).json({ error: "too-long" });
      return;
    }
    const result = await relayProxyMessage({ matchId, senderUserId: req.userId!, body });
    if (!result.ok) {
      answerFailure(res, result.error);
      return;
    }
    res.json(serialize(result.view));
  });

  return router;
}

function serialize(view: ProxyChatView): Record<string, unknown> {
  return {
    open: view.open,
    opensAt: view.opensAt?.toISOString() ?? null,
    closesAt: view.closesAt?.toISOString() ?? null,
    messages: view.messages.map((m) => ({
      id: m.id,
      mine: m.mine,
      body: m.body,
      sentAt: m.sentAt.toISOString(),
    })),
    maxMessageLength: view.maxMessageLength,
    partnerFirstName: view.partnerFirstName,
    serverNow: view.serverNow.toISOString(),
  };
}

/**
 * `wrong-state` and `closed` are 409, not 404: the match exists and the caller
 * is on it — the window is simply not open, or this is not a scheduled date.
 * A 404 there would read as "no such match" and send the client looking for a
 * routing bug that isn't there. `disabled` IS a 404, matching the Mini App
 * routes: with the feature off the endpoint does not exist, rather than
 * existing and being empty.
 */
function answerFailure(res: Response, error: ProxyChatRefusal): void {
  const status =
    error === "forbidden"
      ? 403
      : error === "wrong-state" || error === "closed"
        ? 409
        : error === "empty" || error === "too-long"
          ? 400
          : 404;
  res.status(status).json({ error });
}

function matchIdOf(req: Request): string | null {
  const raw = (req.params as Record<string, string | undefined>).matchId;
  return typeof raw === "string" && UUID_REGEX.test(raw) ? raw : null;
}

/** See routes/calendar.ts for why the UUID shape is pre-validated here. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
