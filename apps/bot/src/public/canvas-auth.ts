import type { Request, Response, NextFunction } from "express";
import { prisma } from "@gennety/db";

import { verifyAccessToken } from "./jwt.js";
import { validateInitData } from "./init-data.js";
import { env } from "../config.js";

/**
 * Accepts EITHER rail — a JWT bearer or Telegram `initData` — and leaves
 * `req.userId` set the same way whichever arrived.
 *
 * ── Why one middleware rather than two routes ───────────────────────────
 *
 * The product's usual shape for a surface that exists on both clients is a
 * shared service behind two routes: `/v1/calendar/state` (initData) and
 * `/v1/matches/:id/calendar` (JWT) both call `getCalendarState`, and
 * `services/post-date-feedback.ts` does the same for the feedback form. That
 * split is right where the two surfaces genuinely differ — the Mini App sends
 * a thank-you DM and the app rail cannot, the native calendar carries a
 * `timeZone` the Mini App does not need.
 *
 * The Living Canvas is the opposite case: it is ONE screen, and both clients
 * want a byte-identical answer. Two routes would then be two copies of the
 * same handler with a rule that they must never diverge — and the reason this
 * repo splits at all is precisely to avoid two implementations of one
 * question. So the split moves to where the difference actually is, which is
 * how the caller proves who they are, and nothing else is duplicated.
 *
 * ── The one asymmetry worth knowing ─────────────────────────────────────
 *
 * The JWT path is stateless (the subject IS the user id); the initData path
 * costs one indexed lookup, because Telegram identifies people by chat id and
 * the rest of the product does not. That is the same trade every initData
 * route here already makes.
 *
 * A Telegram id that matches no row is a 401 rather than a 404: from the
 * caller's side "you are not signed in here" is the truth — the signature was
 * valid, the account is not ours — and answering 404 would let the endpoint
 * distinguish "no such user" from "not your match", which the routes behind
 * this deliberately refuse to do.
 */
export async function requireCanvasAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;

  if (header?.startsWith("Bearer ")) {
    try {
      req.userId = verifyAccessToken(header.slice(7)).sub;
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
    return;
  }

  if (header?.startsWith("tma ")) {
    const initData = header.slice(4).trim();
    if (!initData) {
      res.status(401).json({ error: "Empty initData" });
      return;
    }
    const validation = validateInitData(initData, env.BOT_TOKEN);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid initData", reason: validation.reason });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(validation.user.id) },
      select: { id: true },
    });
    if (!user) {
      res.status(401).json({ error: "Unknown account" });
      return;
    }
    req.userId = user.id;
    next();
    return;
  }

  res.status(401).json({ error: "Missing bearer token or initData" });
}
