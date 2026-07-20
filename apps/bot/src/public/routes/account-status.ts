import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { serializeProfile, serializeUser } from "./serializers.js";
import {
  freezeAccount,
  transitionAccountStatus,
  type StatusTransitionResult,
} from "../../services/account-status-transitions.js";
import { getBotApi } from "../server.js";

/**
 * Matchmaking status control for the native app (IOS_APP_ROADMAP task 0.9):
 * the "Сегодня" gesture (поднял фото → active, вытащил → paused) and the
 * mobile freeze/reactivate parity with the Telegram Settings flow.
 *
 * Mounted at /v1/me BEFORE the main meRouter — unmatched paths fall through.
 */
export const accountStatusRouter: Router = Router();

accountStatusRouter.use(requireAuth);

async function respondWithMe(userId: string, res: Response): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { profile: true },
  });
  res.json({
    user: serializeUser(user),
    profile: user.profile ? serializeProfile(user.profile) : null,
  });
}

/**
 * PATCH /v1/me/status — pause/resume matching.
 *
 * Allowed transitions (mirrors the Telegram menu toggle, plus the mobile
 * equivalent of the /start silent reactivation):
 *   active → paused        (pause)
 *   paused → active        (resume)
 *   frozen → active        (silent reactivation on app return)
 * Same-state requests are idempotent 200s. Every other state (onboarding,
 * suspended, banned, pending_investigation) is 409 — those are owned by
 * their own flows, not this toggle.
 */
accountStatusRouter.patch("/status", async (req: Request, res: Response): Promise<void> => {
  const requested = req.body?.status;
  if (requested !== "active" && requested !== "paused") {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  let result: StatusTransitionResult;
  if (requested === "paused") {
    result = await transitionAccountStatus({ id: req.userId! }, "pause");
  } else {
    result = await transitionAccountStatus({ id: req.userId! }, "resume");
    if (result.kind === "forbidden" && result.status === "frozen") {
      result = await transitionAccountStatus({ id: req.userId! }, "return_from_freeze");
    }
  }

  if (result.kind === "not_found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(409).json({ error: `Cannot switch from ${result.status} to ${requested}` });
    return;
  }
  await respondWithMe(req.userId!, res);
});

/**
 * POST /v1/me/freeze — the soft-delete alternative, Telegram Settings parity.
 * Keeps User/Profile/embedding/verification intact, cancels in-flight matches
 * (partner is notified/compensated on their actual channel), unpins the
 * Telegram status banner for dual-platform users, flips to `frozen`.
 * Reactivation: PATCH /status {active} (or the bot's /start).
 */
accountStatusRouter.post("/freeze", async (req: Request, res: Response): Promise<void> => {
  const result = await freezeAccount({ id: req.userId! }, getBotApi());
  if (result.kind === "not_found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(409).json({ error: `Cannot freeze from ${result.status}` });
    return;
  }
  await respondWithMe(req.userId!, res);
});
