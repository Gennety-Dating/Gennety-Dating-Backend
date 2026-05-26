import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  processCalendarSlotsUpdate,
  getCalendarState,
} from "../../handlers/matching/scheduler.js";

/**
 * RFC 4122 UUID shape. We pre-validate `matchId` here because Prisma rejects a
 * non-UUID value on a `@db.Uuid` column with a synchronous `Error` — not a
 * structured error code we can map to a 400 / 404 cleanly. Letting that bubble
 * yields a 500, which the Mini App surfaces as a generic "try again" alert
 * even when the input is just malformed.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Calendar Mini App endpoints.
 *
 *   POST /v1/calendar/pick   — submit / replace this user's availability set
 *   GET  /v1/calendar/state  — fetch the current grid + both sides' picks
 *
 * Auth on both: `Authorization: tma <initData>` — the standard Telegram
 * Mini App convention. NOT a Bearer JWT — these requests come from the
 * Mini App, not the mobile app, so the bot's token is the only shared
 * secret with the Telegram client.
 *
 * The Mini App polls the GET endpoint every few seconds while open so
 * each side sees the partner's picks land in near-real-time without
 * pulling in WebSocket infrastructure.
 */
export function createCalendarRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.post("/pick", async (req: Request, res: Response): Promise<void> => {
    const validation = authenticate(req);
    if (!validation.ok) {
      res.status(401).json(validation.body);
      return;
    }

    const body = req.body as
      | { matchId?: unknown; pickedIsos?: unknown; pickedIso?: unknown }
      | undefined;
    const matchId = typeof body?.matchId === "string" ? body.matchId : null;

    // Accept the new array shape and the legacy single-ISO shape (for
    // older Mini App bundles still cached on a user's device).
    let pickedIsos: string[] | null = null;
    if (Array.isArray(body?.pickedIsos) && body.pickedIsos.every((x) => typeof x === "string")) {
      pickedIsos = body.pickedIsos as string[];
    } else if (typeof body?.pickedIso === "string") {
      pickedIsos = [body.pickedIso];
    }

    if (!matchId || pickedIsos === null) {
      res.status(400).json({ error: "matchId and pickedIsos are required" });
      return;
    }
    if (!UUID_REGEX.test(matchId)) {
      // 404, not 400 — same UX as a UUID that's syntactically valid but
      // unknown. The Mini App copy is "reopen from the bot" either way,
      // and emitting 404 keeps the alert text consistent for both cases.
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const result = await processCalendarSlotsUpdate(
      api,
      BigInt(validation.user.id),
      matchId,
      pickedIsos,
    );

    if (!result.ok) {
      const status =
        result.reason === "match-not-found" || result.reason === "user-not-found"
          ? 404
          : result.reason === "not-participant"
            ? 403
            : 400;
      res.status(status).json({ error: result.reason });
      return;
    }

    res.status(200).json({
      ok: true,
      mySlots: result.mySlots,
      peerSlots: result.peerSlots,
      agreedTime: result.agreedTime,
      overlapCandidates: result.overlapCandidates,
      bothPicked: result.bothPicked,
    });
  });

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const validation = authenticate(req);
    if (!validation.ok) {
      res.status(401).json(validation.body);
      return;
    }

    const matchId = typeof req.query.matchId === "string" ? req.query.matchId : null;
    if (!matchId) {
      res.status(400).json({ error: "matchId is required" });
      return;
    }
    if (!UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const result = await getCalendarState(BigInt(validation.user.id), matchId);

    if (!result.ok) {
      const status =
        result.reason === "match-not-found" || result.reason === "user-not-found"
          ? 404
          : result.reason === "not-participant"
            ? 403
            : 400;
      res.status(status).json({ error: result.reason });
      return;
    }

    res.status(200).json({
      ok: true,
      proposedTimes: result.proposedTimes,
      mySlots: result.mySlots,
      peerSlots: result.peerSlots,
      agreedTime: result.agreedTime,
      isFirstMover: result.isFirstMover,
    });
  });

  return router;
}

type AuthOk = { ok: true; user: { id: number } };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) {
    return { ok: false, body: { error: "Empty initData" } };
  }

  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id } };
}
