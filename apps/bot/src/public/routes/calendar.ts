import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { processCalendarSlotPick } from "../../handlers/matching/scheduler.js";

/**
 * RFC 4122 UUID shape. We pre-validate `matchId` here because Prisma rejects a
 * non-UUID value on a `@db.Uuid` column with a synchronous `Error` — not a
 * structured error code we can map to a 400 / 404 cleanly. Letting that bubble
 * yields a 500, which the Mini App surfaces as a generic "try again" alert
 * even when the input is just malformed.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Calendar Mini App pick endpoint.
 *
 * `POST /v1/calendar/pick`
 *
 * Why this exists: when the Mini App is opened via an InlineKeyboardButton's
 * `web_app` field (our production path — see scheduler.ts `buildCalendarKeyboard`),
 * `Telegram.WebApp.sendData` is silently a no-op. The bot never receives the
 * pick. So instead the Mini App authenticates with its `initData` blob and
 * POSTs directly to the bot's public API, where we verify the HMAC and apply
 * the same logic the legacy `web_app_data` handler used.
 *
 * Auth: `Authorization: tma <initData>` header — the standard Telegram Mini
 * App convention (TMA = Telegram Mini App). NOT a Bearer JWT — these requests
 * come from the Mini App, not the mobile app, so the bot's token is the only
 * shared secret with the Telegram client.
 *
 * Body: `{ matchId: string, pickedIso: string }` — what slot the user tapped.
 *
 * The router takes `Api` because `processCalendarSlotPick` may DM the user
 * a "waiting on peer" hint when only one side has picked.
 */
export function createCalendarRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.post("/pick", async (req: Request, res: Response): Promise<void> => {
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

    const body = req.body as { matchId?: unknown; pickedIso?: unknown } | undefined;
    const matchId = typeof body?.matchId === "string" ? body.matchId : null;
    const pickedIso = typeof body?.pickedIso === "string" ? body.pickedIso : null;
    if (!matchId || !pickedIso) {
      res.status(400).json({ error: "matchId and pickedIso are required" });
      return;
    }
    // 404, not 400 — same UX as a UUID that's syntactically valid but unknown.
    // The Mini App copy is "reopen from the bot" either way, and emitting 404
    // keeps Mini App alert text consistent for both cases.
    if (!UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const result = await processCalendarSlotPick(
      api,
      BigInt(validation.user.id),
      matchId,
      pickedIso,
    );

    if (!result.ok) {
      // 4xx — client-fixable (wrong match, stale link, etc.). 404 for "we
      // don't know about this match" is friendlier than 400 because it lets
      // the Mini App show a "Reopen the calendar from the bot" message
      // distinct from "your link is malformed".
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
      awaitingPeer: result.awaitingPeer,
      bothPicked: result.bothPicked,
    });
  });

  return router;
}
