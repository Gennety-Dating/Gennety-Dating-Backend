import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { agentTextLimiter, voiceLimiter } from "../rate-limit.js";
import { runMenuAgentTurn } from "../../services/menu-agent.js";
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
}

async function loadUserForAgent(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { telegramId: true, language: true, status: true, onboardingStep: true },
  });
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
  if (user.onboardingStep !== "completed") {
    res.status(409).json({ error: "Onboarding not complete" });
    return;
  }

  const result = await runMenuAgentTurn(user.telegramId, text);
  const dto: AssistantReplyDto = { reply: result.reply };
  res.json(dto);
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
    if (user.onboardingStep !== "completed") {
      res.status(409).json({ error: "Onboarding not complete" });
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
    const dto: AssistantReplyDto = { reply: result.reply, transcript };
    res.json(dto);
  },
);
