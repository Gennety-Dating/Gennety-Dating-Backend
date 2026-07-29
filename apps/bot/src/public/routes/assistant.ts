import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { agentTextLimiter, voiceLimiter } from "../rate-limit.js";
import {
  runMenuAgentTurn,
  type AgentEntryPoint,
  type MenuAgentResult,
} from "../../services/menu-agent.js";
import {
  agentAccessHttpStatus,
  evaluateAgentAccess,
  type AgentAccessDenial,
} from "../../services/agent-access.js";
import { transcribeVoice, WHISPER_MAX_BYTES } from "../../services/whisper.js";

export const assistantRouter: Router = Router();

assistantRouter.use(requireAuth);
assistantRouter.use(usageGuard);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHISPER_MAX_BYTES },
});

interface AssistantReplyDto {
  reply: string;
  transcript?: string | null;
  /**
   * A native affordance the agent asked for but cannot render itself.
   *
   * Previously dropped on the floor here while the Telegram router acted on it,
   * so an API caller was told "a confirmation card is shown" and no card ever
   * appeared — the agent's whole confirm class was silently inert on this
   * surface. Client-side rendering is the client's concern; leaving it out of
   * the response is not.
   */
  action?:
    | { kind: "premium_cancel_confirm" }
    | { kind: "premium_cancel_appstore" }
    | { kind: "entry_point"; entry: AgentEntryPoint };
  /** Code-owned confirmations of writes that actually landed. */
  receipts?: string[];
}

/** Shape one agent turn into the wire DTO, carrying action + receipts through. */
function toReplyDto(
  result: MenuAgentResult,
  transcript?: string,
): AssistantReplyDto {
  return {
    reply: result.reply,
    ...(transcript ? { transcript } : {}),
    ...(result.action ? { action: result.action } : {}),
    ...(result.receipts ? { receipts: result.receipts } : {}),
  };
}

async function loadUserForAgent(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      telegramId: true,
      language: true,
      status: true,
      onboardingStep: true,
      suspendedUntil: true,
    },
  });
}

/** Denial payload for the JWT surface — same rule the Telegram router applies. */
function denyResponse(res: Response, reason: AgentAccessDenial): void {
  res.status(agentAccessHttpStatus(reason)).json({ error: reason });
}

/**
 * Post-onboarding conversational assistant. Wraps `runMenuAgentTurn` so the
 * mobile app can reuse the exact same LLM router the Telegram bot uses —
 * profile edits, pause/resume, rejection feedback, etc.
 *
 * Gated on `onboardingStep === "completed"` so half-onboarded users keep
 * talking to the onboarding agent via /v1/onboarding/* instead.
 */
assistantRouter.post("/ask", agentTextLimiter, async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  if (text.length > 4_000) {
    res.status(400).json({ error: "Text is too long" });
    return;
  }

  const user = await loadUserForAgent(req.userId!);
  // The same gate the Telegram surface applies. Without it a verification-gated
  // or moderated account reached the identical agent — and its write tools — by
  // switching transport.
  const access = evaluateAgentAccess(user);
  if (!access.allowed) {
    denyResponse(res, access.reason);
    return;
  }

  const result = await runMenuAgentTurn(user.telegramId, text);
  res.json(toReplyDto(result));
});

assistantRouter.post(
  "/voice",
  voiceLimiter,
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }

    const user = await loadUserForAgent(req.userId!);
    const access = evaluateAgentAccess(user);
    if (!access.allowed) {
      denyResponse(res, access.reason);
      return;
    }

    const transcript = await transcribeVoice(req.file.buffer, {
      mime: req.file.mimetype,
      ...(user.language ? { language: user.language } : {}),
    });
    if (!transcript) {
      res.status(422).json({ error: "Could not transcribe audio" });
      return;
    }

    const result = await runMenuAgentTurn(user.telegramId, transcript);
    res.json(toReplyDto(result, transcript));
  },
);
