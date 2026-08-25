import { Router, type Request, type Response } from "express";

import { requireAuth } from "../auth-middleware.js";
import {
  announceBumpVerified,
  generateAndStoreBumpDeck,
  recordBump,
  type BumpRefusal,
} from "../../services/date-bump.js";

/**
 * `POST /v1/dates/:matchId/bump` — one side's shake (PRODUCT_SPEC §6.2).
 *
 * The client detects the shake (CoreMotion on iOS, `DeviceMotionEvent` in the
 * Mini App) and posts when and where it happened. **The server decides whether
 * it counts** — the window, the radius and the alignment are all re-checked
 * here, because a client-side verdict is a client-side ticket grant.
 *
 * `at` is the DEVICE's clock and is deliberately trusted only as far as the
 * server's own bounds allow: it is clamped into the accepted window before
 * anything reads it, so a phone with a wrong date cannot bump its way outside
 * the date, and two phones that disagree by seconds still align.
 */
export const dateBumpRouter: Router = Router();

dateBumpRouter.use(requireAuth);

/** How far the device clock may run ahead of ours before we stop trusting it. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const REFUSAL_STATUS: Record<BumpRefusal, number> = {
  // The caller is authenticated and simply not on this match — 404 rather than
  // 403 so the endpoint cannot be used to probe which match ids exist.
  "not-participant": 404,
  "wrong-state": 409,
  "too-early": 409,
  "too-late": 409,
  "too-far": 409,
};

dateBumpRouter.post(
  "/:matchId/bump",
  async (req: Request, res: Response): Promise<void> => {
    const matchId = (req.params as Record<string, string | undefined>).matchId;
    if (!matchId || !isUuid(matchId)) {
      res.status(400).json({ error: "matchId must be a UUID" });
      return;
    }

    const body = req.body as { lat?: unknown; lng?: unknown; at?: unknown };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: "lat and lng are required" });
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: "lat/lng out of range" });
      return;
    }

    const at = resolveShakeTime(body.at, new Date());

    const outcome = await recordBump({
      matchId,
      userId: req.userId!,
      at,
      coords: { lat, lng },
    });

    if (!outcome.ok) {
      res.status(REFUSAL_STATUS[outcome.reason!] ?? 409).json({ error: outcome.reason });
      return;
    }

    // The deck and the announcement hang off the ONE call that verified the
    // pair, never off `verified` — otherwise the partner's own shake, arriving
    // a beat later and correctly reporting `verified: true`, would generate a
    // second deck and send the whole thing twice.
    if (outcome.justVerified) {
      // Deliberately awaited rather than fired and forgotten: this is the
      // response the client draws its deck from, and the pair is sitting at a
      // table looking at it. `generateAndStoreBumpDeck` has its own fallback,
      // so a slow model costs seconds, never the screen.
      const deck = await generateAndStoreBumpDeck(matchId).catch((err: unknown) => {
        console.error("[date-bump] deck generation failed:", err);
        return null;
      });
      await announceBumpVerified(matchId).catch((err: unknown) => {
        console.error("[date-bump] announce failed:", err);
      });

      res.json({ ok: true, verified: true, deck: deck ?? null });
      return;
    }

    res.json({ ok: true, verified: outcome.verified, deck: null });
  },
);

/**
 * The device's own timestamp, bounded by ours.
 *
 * A client clock is the only thing the phone can honestly report about WHEN it
 * was shaken, and the two phones' clocks are what the alignment check compares
 * — so it has to be used. What it must not be is authoritative: a device an
 * hour fast would otherwise bump outside its own date. Anything further from
 * the server's clock than the tolerance is replaced by the server's, which
 * fails toward "this shake happened now" rather than toward a refusal.
 */
export function resolveShakeTime(raw: unknown, serverNow: Date): Date {
  if (typeof raw !== "string") return serverNow;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return serverNow;
  if (Math.abs(parsed.getTime() - serverNow.getTime()) > CLOCK_SKEW_TOLERANCE_MS) {
    return serverNow;
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
