import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import {
  proxyChatReader,
  readProxyChat,
  relayProxyMessage,
  reactToProxyMessage,
  reportProxyChatPresence,
  type ProxyChatRefusal,
  type ProxyChatView,
} from "../../services/proxy-chat.js";
import {
  PROXY_CHAT_HOLD_MS,
  leaveChat,
  markPresence,
  waitForProxyChatChange,
  type PartnerPresence,
} from "../../services/proxy-presence.js";
import { PROXY_MAX_MESSAGE_LEN } from "@gennety/shared";

/**
 * Anonymous pre-date chat for the NATIVE client (JWT) — PRODUCT_SPEC §Phase 4.
 *
 * The third instance of the same hole the ticket gate and the calendar had: the
 * proxy relay existed only as a Telegram chat session, so an app user could not
 * read a message their partner sent, let alone answer one. Worse than those
 * two, because the window is a single hour wide and exists precisely for the
 * person standing outside a venue looking for someone.
 *
 *   GET  /v1/matches/:id/chat  — window state + messages (`?since=` for a delta,
 *                                 `?after=<version>` to hold until something changes)
 *   POST /v1/matches/:id/chat  — relay one text message
 *   POST /v1/matches/:id/chat/presence — "I'm in the app / here / typing / gone"
 *
 * Both answer the same shape so a send needs no follow-up read. Every decision
 * — is the window open, what gets logged, how the partner is reached — belongs
 * to `services/proxy-chat.ts` and is shared with the Telegram relay; this file
 * only maps refusals onto status codes.
 */
export function createProxyChatRouter(
  options: { holdMs?: number } = {},
): Router {
  const holdMs = options.holdMs ?? PROXY_CHAT_HOLD_MS;
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
    // A version is a short opaque stamp (`proxy-presence.ts`); anything longer
    // is not one of ours and is answered at once, like a stale one.
    const after =
      typeof req.query.after === "string" && req.query.after.length <= 64 ? req.query.after : null;

    // Gate BEFORE holding: a stranger must not park a connection on someone
    // else's date, nor stamp presence onto it.
    const reader = await proxyChatReader({ matchId, userId: req.userId! });
    if (!reader.ok) {
      answerFailure(res, reader.error);
      return;
    }
    const holdUntil = after ? Date.now() + holdMs : undefined;
    // Reading the chat IS being on the chat screen — that is the whole beat.
    if (reader.live) {
      markPresence({
        matchId,
        userId: req.userId!,
        place: "chat",
        ...(holdUntil ? { holdUntil } : {}),
      });
    }

    if (after && holdUntil) {
      // The long-poll (DECISIONS 2026-09-30): answered at once when `after` is
      // stale, otherwise held until the next change or `holdMs`. The client
      // going away ends the wait; a 'close' AFTER our response is the ordinary
      // end of the exchange and must not count, hence `writableFinished` —
      // the same shape as the Bump's hold (routes/date-bump.ts).
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableFinished) controller.abort();
      };
      res.on("close", onClose);
      if (res.socket == null || res.socket.destroyed) controller.abort();
      await waitForProxyChatChange(matchId, { after, until: holdUntil, signal: controller.signal });
      res.off("close", onClose);
      if (controller.signal.aborted) {
        // The screen went away mid-hold: say so to the partner now rather than
        // when the hold's grace runs out, and answer nobody. Reading here
        // would also move the read cursor for a screen that is gone.
        if (reader.live) leaveChat(matchId, req.userId!);
        return;
      }
    }

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

  // Presence: where the caller is, and where their partner is. A POST, not a
  // PUT — each call is a beat with an expiry, not a stored value to overwrite.
  router.post("/presence", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const body = req.body as { place?: unknown; typing?: unknown } | undefined;
    const result = await reportProxyChatPresence({
      matchId,
      userId: req.userId!,
      place: body?.place,
      ...(body && "typing" in body ? { typing: body.typing } : {}),
    });
    if (!result.ok) {
      answerFailure(res, result.error);
      return;
    }
    res.json({
      partnerPresence: serializePresence(result.partnerPresence),
      version: result.version,
    });
  });

  // PUT rather than POST, and that is not pedantry: one message carries at most
  // one reaction, so pressing ❤ twice must leave the same state as pressing it
  // once. A POST would invite a client to think it is appending to a list, and
  // this endpoint has no list to append to.
  router.put("/messages/:messageId/reaction", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const messageId = (req.params as Record<string, string | undefined>).messageId;
    if (typeof messageId !== "string" || !UUID_REGEX.test(messageId)) {
      res.status(404).json({ error: "no-message" });
      return;
    }
    // `null` is a VALUE here, not a missing field: it means "take the reaction
    // off". Absent means the client sent a malformed body, and the two must not
    // collapse into the same branch — one is an un-react, the other a bug.
    const raw = (req.body as { reaction?: unknown } | undefined)?.reaction;
    if (raw !== null && typeof raw !== "string") {
      res.status(400).json({ error: "bad-reaction" });
      return;
    }
    const result = await reactToProxyMessage({
      matchId,
      messageId,
      userId: req.userId!,
      reaction: raw,
    });
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
      // Omitted, not null, on the partner's messages: the contract says the
      // key is absent there, and `status: null` would invite a client to
      // render a fourth, empty state.
      ...(m.status ? { status: m.status } : {}),
      // Same omit-don't-null rule as `status`, for the same reason: absent is
      // "nobody reacted", and a null would invite an empty capsule.
      ...(m.reaction ? { reaction: m.reaction } : {}),
    })),
    maxMessageLength: view.maxMessageLength,
    partnerFirstName: view.partnerFirstName,
    serverNow: view.serverNow.toISOString(),
    partnerPresence: serializePresence(view.partnerPresence),
    version: view.version,
  };
}

function serializePresence(presence: PartnerPresence): Record<string, boolean> {
  return { online: presence.online, inChat: presence.inChat, typing: presence.typing };
}

/**
 * `wrong-state` and `closed` are 409, not 404: the match exists and the caller
 * is on it — the window is simply not open, or this is not a scheduled date.
 * A 404 there would read as "no such match" and send the client looking for a
 * routing bug that isn't there. `disabled` IS a 404, matching the Mini App
 * routes: with the feature off the endpoint does not exist, rather than
 * existing and being empty.
 *
 * `own-message` is 403 and not 400: the request is well-formed, the caller is
 * simply not allowed to react to their own line. `bad-reaction` is 400 — an
 * emoji outside the closed set is a malformed request, and answering 403 would
 * send a client hunting for a permission it never needed.
 */
function answerFailure(res: Response, error: ProxyChatRefusal): void {
  const status =
    error === "forbidden" || error === "own-message"
      ? 403
      : error === "wrong-state" || error === "closed"
        ? 409
        : error === "empty" ||
            error === "too-long" ||
            error === "bad-reaction" ||
            error === "bad-presence"
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
