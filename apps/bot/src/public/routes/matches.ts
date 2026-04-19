import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
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

matchesRouter.get("/current", async (req: Request, res: Response): Promise<void> => {
  const match = await getCurrentMatchForUser(req.userId!);
  res.json(match);
});

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
