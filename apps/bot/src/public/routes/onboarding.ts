import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { voiceLimiter } from "../rate-limit.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { transcribeVoice, WHISPER_MAX_BYTES } from "../../services/whisper.js";
import { serializeUser } from "./serializers.js";
import { buildInterviewState, loadStateContext } from "./onboarding-state.js";

export const onboardingRouter: Router = Router();

onboardingRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHISPER_MAX_BYTES },
});

async function loadUser(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { telegramId: true, onboardingStep: true, messageHistory: true, language: true },
  });
}

/**
 * GET /v1/onboarding/interview
 * Returns the current step + the most recent assistant prompt. When no
 * history exists yet the client should POST an opener (e.g. "hi") to trigger
 * the first agent turn.
 */
onboardingRouter.get("/interview", async (req: Request, res: Response): Promise<void> => {
  const ctx = await loadStateContext(req.userId!);
  res.json(buildInterviewState(ctx));
});

onboardingRouter.post("/interview/answer", async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  const user = await loadUser(req.userId!);
  const result = await runAgentTurn(user.telegramId, text);

  const ctx = await loadStateContext(req.userId!);
  res.json(buildInterviewState({ ...ctx, question: result.reply }));
});

/**
 * POST /v1/onboarding/consent — Initialization & Consent screen.
 *
 * Records the explicit ToS click and the optional research opt-in, then
 * advances `onboardingStep` from `consent` → `language` (idempotent: a
 * later step is preserved). `termsAccepted` is the legal gate and MUST be
 * the boolean literal `true`; `researchOptIn` is optional and defaults to
 * false. Both fields reject any non-boolean type — no truthy coercion.
 */
onboardingRouter.post("/consent", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const termsAccepted = body.termsAccepted;
  const researchOptIn = body.researchOptIn;

  if (termsAccepted !== true) {
    res.status(400).json({ error: "Terms must be accepted" });
    return;
  }
  if (researchOptIn !== undefined && typeof researchOptIn !== "boolean") {
    res.status(400).json({ error: "Invalid researchOptIn" });
    return;
  }

  const current = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
    select: { onboardingStep: true },
  });

  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      termsAccepted: true,
      termsAcceptedAt: new Date(),
      researchOptIn: researchOptIn ?? false,
      ...(current.onboardingStep === "consent" ? { onboardingStep: "language" as const } : {}),
    },
  });

  res.json({ user: serializeUser(user) });
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
    const ctx = await loadStateContext(req.userId!);
    res.json(buildInterviewState({ ...ctx, question: result.reply, acknowledgement: transcript }));
  },
);
