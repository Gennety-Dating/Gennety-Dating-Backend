import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { agentTextLimiter } from "../rate-limit.js";
import { classifyMatchDecisionForUser } from "../../services/decision-intent.js";
import { countPartnerPhotos, partnerPhotoUrls } from "../partner-photos.js";
import {
  getCurrentMatchForUser,
  applyMatchDecision,
  submitVibeLocation,
  acknowledgeSafetyBrief,
  submitMatchReport,
  type MatchDecision,
  type MobileVibeLocationPayload,
  type MobileReportPayload,
  type VibeTag,
  type ReportCategory,
} from "../matches-service.js";
import {
  confirmVenueIntent,
  getVenueIntentState,
  interpretVenueIntent,
  venueIntentMode,
  type ConfirmVenueIntentInput,
} from "../../services/venue-intent-v2.js";
import {
  cancelScheduledDate,
  EMERGENCY_REASON_MAX_LENGTH,
} from "../../services/emergency-cancel.js";
import {
  assertDepartureOrigin,
  isVenueOriginRefusal,
  venueOriginRefusal,
} from "../../services/venue-origin.js";

export const matchesRouter: Router = Router();

matchesRouter.use(requireAuth);

// Express 5 types `req.params[k]` as `string | string[]` to support the
// `foo[bar]` syntax. Our routes use plain `/:id`, so coerce to string.
function paramId(req: Request): string {
  const raw = req.params.id;
  return typeof raw === "string" ? raw : "";
}

const VIBE_TAGS = new Set<VibeTag>(["coffee", "walk", "drinks", "study"]);
const REPORT_CATEGORIES = new Set<ReportCategory>([
  "tier1_disappointment",
  "tier2_ghosting",
  "tier3_safety",
]);

/**
 * GET /v1/matches/:id/partner-photos — URLs for the native cinematic pitch.
 *
 * Deliberately NOT a field on `SerializedMatch`: `/current` is polled, and
 * minting signed URLs on every poll would be work nobody asked for. The pitch
 * needs them once, when it opens.
 *
 * Who may load them is decided in `public/partner-photos.ts` — participant of
 * a live match, and nobody else.
 */
matchesRouter.get("/:id/partner-photos", async (req: Request, res: Response): Promise<void> => {
  const count = await countPartnerPhotos(req.userId!, paramId(req));
  if (count === null) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  res.json({ urls: partnerPhotoUrls(req.userId!, paramId(req), count) });
});

matchesRouter.get("/current", async (req: Request, res: Response): Promise<void> => {
  const match = await getCurrentMatchForUser(req.userId!);
  // Wrapped (2026-07-18, mobile contract): a bare `null` JSON body is
  // awkward for typed clients — `{ match: null }` keeps the envelope stable.
  res.json({ match });
});

/**
 * POST /v1/matches/:id/decision-intent — classify a free-text answer to the
 * pitch question ("хочешь пойти на свидание?"). The кино-питч's conversational
 * decision: the client shows the guarded confirm card for `yes`/`no`, a
 * no-rush nudge for `unsure`, and treats `other` as ordinary chat. Text
 * NEVER commits — the commit stays `POST /:id/decision` behind an explicit
 * tap (blind-decision invariant untouched).
 */
matchesRouter.post(
  "/:id/decision-intent",
  agentTextLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const id = paramId(req);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 1_000) {
      res.status(400).json({ error: "Invalid text" });
      return;
    }

    const intent = await classifyMatchDecisionForUser(id, req.userId!, text);
    if (!intent) {
      res.status(404).json({ error: "Match not found or not actionable" });
      return;
    }
    res.json({ intent });
  },
);

matchesRouter.post("/:id/decision", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const decision = req.body?.decision as MatchDecision | undefined;
  if (decision !== "accept" && decision !== "decline") {
    res.status(400).json({ error: "Invalid decision" });
    return;
  }

  const result = await applyMatchDecision(id, req.userId!, decision);
  if (!result) {
    res.status(404).json({ error: "Match not found or not actionable" });
    return;
  }
  res.json(result);
});

matchesRouter.get("/:id/venue-intent", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const result = await getVenueIntentState(id, req.userId!);
  if (!result) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  res.json({ ...result, mode: venueIntentMode(id) });
});

matchesRouter.post(
  "/:id/venue-intent/interpret",
  agentTextLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const id = paramId(req);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 500) {
      res.status(400).json({ error: "Text must be 1–500 characters" });
      return;
    }
    const intent = await interpretVenueIntent(id, req.userId!, text, req.body?.origin ?? null);
    if (isVenueOriginRefusal(intent)) {
      res.status(400).json(intent);
      return;
    }
    if (!intent) {
      res.status(409).json({ error: "Match not in venue negotiation" });
      return;
    }
    res.json({ intent });
  },
);

matchesRouter.put("/:id/venue-intent", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const body = req.body as ConfirmVenueIntentInput | undefined;
  if (!body?.origin || !Array.isArray(body.experiences) || !Array.isArray(body.ambiences) || !Array.isArray(body.formats) || !body.hardConstraints) {
    res.status(400).json({ error: "Invalid venue intent" });
    return;
  }
  const result = await confirmVenueIntent(id, req.userId!, body);
  // A pin outside the caller's launched market gets its own reason so the
  // native client can name the city on the screen that can still fix it,
  // rather than reporting it as "draft not found" (PRODUCT_SPEC §3.7).
  if (isVenueOriginRefusal(result)) {
    res.status(400).json(result);
    return;
  }
  if (!result) {
    res.status(409).json({ error: "Draft not found or match not actionable" });
    return;
  }
  res.json(result);
});

matchesRouter.post("/:id/vibe-location", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const { vibe, lat, lng } = (req.body ?? {}) as Partial<MobileVibeLocationPayload>;

  if (!vibe || !VIBE_TAGS.has(vibe as VibeTag)) {
    res.status(400).json({ error: "Invalid vibe" });
    return;
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat/lng must be numbers" });
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng out of range" });
    return;
  }
  // The departure-point gate (PRODUCT_SPEC §3.7). This is the legacy mobile
  // twin of `POST /v1/location/select`, and it writes the same
  // `vibeLat/Lng` columns, so it needs the same guard.
  const gate = await assertDepartureOrigin(req.userId!, lat, lng);
  if (!gate.ok) {
    res.status(400).json(venueOriginRefusal(gate.market));
    return;
  }

  const result = await submitVibeLocation(id, req.userId!, { vibe, lat, lng });
  if (!result) {
    res.status(409).json({ error: "Match not in a negotiating state" });
    return;
  }
  res.json(result);
});

matchesRouter.post("/:id/safety-ack", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const result = await acknowledgeSafetyBrief(id, req.userId!);
  if (!result) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  res.json(result);
});

/**
 * Emergency cancellation of a scheduled date (PRODUCT_SPEC §Phase 4, iOS §4.4).
 *
 * The reason is **mandatory** and forwarded to the partner verbatim — that is
 * the product rule, not a validation detail: cancelling on someone an hour
 * before is allowed to be a real decision, and the person it lands on is owed
 * the actual sentence rather than a system notice. The client is expected to
 * guard this behind its own two-step confirmation; the server does not enforce
 * one because a guard the caller can skip is not a guard, and the irreversible
 * step here is the request itself.
 */
matchesRouter.post("/:id/cancel", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const { reason } = (req.body ?? {}) as { reason?: unknown };

  if (typeof reason !== "string" || reason.trim().length === 0) {
    res.status(400).json({ error: "Reason is required" });
    return;
  }
  if (reason.trim().length > EMERGENCY_REASON_MAX_LENGTH) {
    res.status(413).json({ error: "Reason is too long" });
    return;
  }

  const result = await cancelScheduledDate({
    matchId: id,
    actorUserId: req.userId!,
    reason,
  });

  if (!result.ok) {
    if (result.error === "not-found") {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    if (result.error === "forbidden") {
      res.status(403).json({ error: "Not a participant of this match" });
      return;
    }
    // Already cancelled, or never got as far as a scheduled date. 409 rather
    // than 404: the match exists and the caller is on it.
    res.status(409).json({ error: "Match is not a scheduled date" });
    return;
  }

  const refunded =
    result.outcome.refunds.find((entry) => entry.userId === req.userId!)?.refunded ?? 0;
  res.json({ ok: true, ticketsRefunded: refunded });
});

matchesRouter.post("/:id/report", async (req: Request, res: Response): Promise<void> => {
  const id = paramId(req);
  const { category, message } = (req.body ?? {}) as Partial<MobileReportPayload>;

  if (!category || !REPORT_CATEGORIES.has(category as ReportCategory)) {
    res.status(400).json({ error: "Invalid category" });
    return;
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "Message is required" });
    return;
  }
  if (message.trim().length > 1_000) {
    res.status(413).json({ error: "Message is too long" });
    return;
  }

  const outcome = await submitMatchReport(id, req.userId!, {
    category,
    message: message.trim(),
  });

  if (outcome === "forbidden") {
    res.status(403).json({ error: "Not a participant of this match" });
    return;
  }
  if (outcome === "duplicate") {
    res.status(409).json({ error: "You have already reported this match" });
    return;
  }
  res.status(204).end();
});
