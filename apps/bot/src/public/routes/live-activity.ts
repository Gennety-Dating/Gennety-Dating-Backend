import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";

/**
 * Live Activity push-token registration for the native iOS client
 * (IOS_APP_ROADMAP task 0.3). ActivityKit hands the app a `start` token
 * (push-to-start, per activity type) and an `update` token (per running
 * activity); both are POSTed here so `services/push.ts` can drive the
 * "match decision" and "date day" activities remotely via APNs.
 *
 * One row per (user, activityType, kind) — the single-live-match invariant
 * guarantees a user never runs two activities of the same type, so
 * re-registration upserts in place.
 */
export const liveActivityRouter: Router = Router();

liveActivityRouter.use(requireAuth);

const ACTIVITY_TYPES = new Set(["match_decision", "date_day"]);
const KINDS = new Set(["start", "update"]);
const TOKEN_MAX_LENGTH = 200;

liveActivityRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const activityType = typeof body.activityType === "string" ? body.activityType : "";
  const kind = typeof body.kind === "string" ? body.kind : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const matchId = typeof body.matchId === "string" ? body.matchId : null;

  if (!ACTIVITY_TYPES.has(activityType) || !KINDS.has(kind)) {
    res.status(400).json({ error: "Invalid activityType or kind" });
    return;
  }
  if (!token || token.length > TOKEN_MAX_LENGTH) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  await prisma.liveActivityToken.upsert({
    where: {
      userId_activityType_kind: { userId: req.userId!, activityType, kind },
    },
    update: { token, matchId },
    create: { userId: req.userId!, activityType, kind, token, matchId },
  });

  res.json({ ok: true });
});

/**
 * The client calls DELETE when an activity ends locally (dismissed / expired)
 * so the server stops pushing updates into the void.
 */
liveActivityRouter.delete(
  "/:activityType/:kind",
  async (req: Request, res: Response): Promise<void> => {
    const activityType =
      typeof req.params.activityType === "string" ? req.params.activityType : "";
    const kind = typeof req.params.kind === "string" ? req.params.kind : "";
    if (!ACTIVITY_TYPES.has(activityType) || !KINDS.has(kind)) {
      res.status(400).json({ error: "Invalid activityType or kind" });
      return;
    }

    await prisma.liveActivityToken.deleteMany({
      where: { userId: req.userId!, activityType, kind },
    });
    res.status(204).end();
  },
);
