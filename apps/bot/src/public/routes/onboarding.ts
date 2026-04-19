import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma, type OnboardingStep } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { voiceLimiter } from "../rate-limit.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { transcribeVoice, WHISPER_MAX_BYTES } from "../../services/whisper.js";

export const onboardingRouter: Router = Router();

onboardingRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHISPER_MAX_BYTES },
});

interface InterviewStateDto {
  stepIndex: number;
  totalSteps: number;
  question: string | null;
  completed: boolean;
  acknowledgement?: string | null;
}

// Onboarding has 4 discrete DB steps (`OnboardingStep` enum). We expose them
// as `stepIndex` for the mobile progress bar — the conversational step itself
// is LLM-driven and has no sub-steps the server tracks.
const STEP_ORDER: OnboardingStep[] = ["consent", "language", "conversational", "completed"];

function stateFor(step: OnboardingStep, question: string | null): InterviewStateDto {
  return {
    stepIndex: STEP_ORDER.indexOf(step),
    totalSteps: STEP_ORDER.length,
    question,
    completed: step === "completed",
  };
}

async function loadUser(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { telegramId: true, onboardingStep: true, messageHistory: true, language: true },
  });
}

function lastAssistantMessage(history: unknown[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as { role?: string; content?: string } | null;
    if (msg?.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content;
    }
  }
  return null;
}

/**
 * GET /v1/onboarding/interview
 * Returns the current step + the most recent assistant prompt. When no
 * history exists yet the client should POST an opener (e.g. "hi") to trigger
 * the first agent turn.
 */
onboardingRouter.get("/interview", async (req: Request, res: Response): Promise<void> => {
  const user = await loadUser(req.userId!);
  const question = lastAssistantMessage(user.messageHistory as unknown[]);
  res.json(stateFor(user.onboardingStep, question));
});

onboardingRouter.post("/interview/answer", async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  const user = await loadUser(req.userId!);
  const result = await runAgentTurn(user.telegramId, text);

  const reloaded = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
    select: { onboardingStep: true },
  });
  res.json(stateFor(reloaded.onboardingStep, result.reply));
});

onboardingRouter.post(
  "/interview/voice",
  voiceLimiter,
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }

    const user = await loadUser(req.userId!);
    const transcript = await transcribeVoice(req.file.buffer, {
      mime: req.file.mimetype,
      ...(user.language ? { language: user.language } : {}),
    });
    if (!transcript) {
      res.status(422).json({ error: "Could not transcribe audio" });
      return;
    }

    const result = await runAgentTurn(user.telegramId, transcript);
    const reloaded = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { onboardingStep: true },
    });
    const state = stateFor(reloaded.onboardingStep, result.reply);
    res.json({ ...state, acknowledgement: transcript });
  },
);
