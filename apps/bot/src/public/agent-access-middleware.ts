import type { Request, Response, NextFunction } from "express";
import { prisma } from "@gennety/db";
import {
  agentAccessHttpStatus,
  evaluateAgentAccess,
} from "../services/agent-access.js";

/**
 * The `agent-access.ts` rule as Express middleware.
 *
 * That module's docstring names the failure it exists to prevent: "Anything
 * that gates the agent belongs in this function rather than in a middleware,
 * precisely so a third entry point cannot be written without it." `/v1/chat`
 * was written as exactly that third entry point and asked nothing — so a
 * `banned` / `suspended` / `pending_investigation` account, and one still held
 * behind the verification card, kept a multimodal LLM conversation running and
 * kept its profile-writing tools (`update_profile`, `attach_profile_photo`)
 * simply by being on iOS instead of Telegram. `requireAuth` only proves the JWT
 * is valid and `usageGuard` only counts tokens; neither reads `status`, and the
 * refresh route does not re-check it either, so the door stayed open for as
 * long as the refresh token lived.
 *
 * The rule itself is deliberately NOT reimplemented here — this only carries
 * the existing decision to a surface shaped like a router. Mount **after**
 * `requireAuth` so `req.userId` is set.
 */
export async function requireAgentAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    // Unreachable behind `requireAuth`, but a missing id must never read as
    // "allowed": this is the gate, and gates fail closed.
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  // `findUnique`, not `findUniqueOrThrow`: a token outliving its account is an
  // ordinary denial, not a 500. `evaluateAgentAccess(null)` answers it.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, onboardingStep: true, suspendedUntil: true },
  });

  const access = evaluateAgentAccess(user);
  if (!access.allowed) {
    res.status(agentAccessHttpStatus(access.reason)).json({ error: access.reason });
    return;
  }

  next();
}
