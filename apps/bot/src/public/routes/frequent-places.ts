import { Router, type Request, type Response } from "express";

import { requireCanvasAuth } from "../canvas-auth.js";
import { canvasLimiter } from "../rate-limit.js";
import {
  fencesForUser,
  isPlaceId,
  readFrequentPlaces,
  recordPresence,
  setFrequentPlacesOptIn,
  setPlaceHidden,
  type PresenceReport,
  type PresenceRefusal,
} from "../../services/frequent-places.js";
import type {
  FrequentPlace,
  FrequentPlaceRanking,
} from "../../services/frequent-places-rules.js";

/**
 * Frequently visited places (docs/product/domains/frequent-places.md).
 *
 * `GET  /v1/frequent-places` — the owner's list: what the match sees, then
 *   what the owner hid, so one call draws the section.
 * `PUT  /v1/frequent-places/opt-in` — the consent (on by default, founder
 *   decision 2026-09-11).
 * `PUT  /v1/frequent-places/:placeId/visibility` — hide one place, or bring
 *   it back.
 * `GET  /v1/frequent-places/fences` — the city's places as circles, for the
 *   client's pre-filter.
 * `POST /v1/frequent-places/presence` — one foreground fix at a place, or
 *   "I left".
 *
 * Its own prefix and either rail, the Scratch Map's shape: it is a feature of
 * the person rather than of the client they use, and it runs under a consent
 * of its own. What the MATCH sees is not here — it rides on
 * `/v1/matches/current` (`partnerFrequentPlaces`), built by the one function
 * allowed to build it.
 */
export const frequentPlacesRouter: Router = Router();

frequentPlacesRouter.use(requireCanvasAuth);
// After auth, so the key is the person (see `canvasLimiter`). The presence
// cadence is one fix per ten minutes, far inside it.
frequentPlacesRouter.use(canvasLimiter);

const REFUSAL_STATUS: Record<PresenceRefusal, number> = {
  // A setting, not a retryable error: the client stops sending.
  "opted-out": 409,
};

/** Shown places in rank order, then hidden ones — each carries `hidden`. */
export function ownerPlaces(ranking: FrequentPlaceRanking): FrequentPlace[] {
  return [...ranking.shown, ...ranking.hidden];
}

/**
 * A presence report, strictly: numbers must arrive as numbers (no coercion of
 * `"50.4"`), and a fix outside the globe or with a negative age is refused
 * rather than clamped. `{ away: true }` carries nothing else, by design — the
 * one report that is sent when the person is NOT at a place has no position in
 * it.
 */
export function parsePresence(body: unknown): PresenceReport | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as Record<string, unknown>;
  if (fields.away === true) return { kind: "away" };

  const { lat, lng, accuracyM, ageSeconds } = fields;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    typeof accuracyM !== "number" ||
    typeof ageSeconds !== "number"
  ) {
    return null;
  }
  if (![lat, lng, accuracyM, ageSeconds].every(Number.isFinite)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || accuracyM < 0 || ageSeconds < 0) return null;
  return { kind: "fix", fix: { lat, lng, accuracyM }, ageSeconds };
}

async function sendOwnerView(
  res: Response,
  userId: string,
  acknowledged: boolean,
): Promise<void> {
  const { optIn, ranking } = await readFrequentPlaces(userId);
  const body = { optIn, places: ownerPlaces(ranking) };
  res.json(acknowledged ? { ok: true, ...body } : body);
}

frequentPlacesRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  await sendOwnerView(res, req.userId!, false);
});

frequentPlacesRouter.put("/opt-in", async (req: Request, res: Response): Promise<void> => {
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  await setFrequentPlacesOptIn(req.userId!, enabled);
  await sendOwnerView(res, req.userId!, true);
});

frequentPlacesRouter.get("/fences", async (req: Request, res: Response): Promise<void> => {
  res.json(await fencesForUser(req.userId!));
});

frequentPlacesRouter.post("/presence", async (req: Request, res: Response): Promise<void> => {
  const report = parsePresence(req.body);
  if (!report) {
    res.status(400).json({
      error: "expected { lat, lng, accuracyM, ageSeconds } as numbers, or { away: true }",
    });
    return;
  }
  const result = await recordPresence({ userId: req.userId!, report });
  if ("refused" in result) {
    res.status(REFUSAL_STATUS[result.refused]).json({ error: result.refused });
    return;
  }
  // Whether this fix completed a visit is not the client's business: it would
  // turn every fix into a "you were seen at X" receipt and changes nothing the
  // client does next.
  res.json({ ok: true });
});

frequentPlacesRouter.put(
  "/:placeId/visibility",
  async (req: Request, res: Response): Promise<void> => {
    const placeId = String(req.params.placeId ?? "");
    if (!isPlaceId(placeId)) {
      res.status(400).json({ error: "invalid placeId" });
      return;
    }
    const hidden = (req.body as { hidden?: unknown } | undefined)?.hidden;
    if (typeof hidden !== "boolean") {
      res.status(400).json({ error: "hidden must be a boolean" });
      return;
    }
    await setPlaceHidden(req.userId!, placeId, hidden);
    await sendOwnerView(res, req.userId!, true);
  },
);
