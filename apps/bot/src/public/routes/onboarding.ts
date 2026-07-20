import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "@gennety/db";
import {
  MAX_DUMP_BUFFER_CHARS,
  SUPPORTED_LANGUAGES,
  type Language,
} from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { agentTextLimiter, voiceLimiter } from "../rate-limit.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { hasTrackVerifiedContact } from "../../services/contact-verification.js";
import { transcribeVoice, WHISPER_MAX_BYTES } from "../../services/whisper.js";
import { serializeUser } from "./serializers.js";
import { buildInterviewState, loadStateContext } from "./onboarding-state.js";

export const onboardingRouter: Router = Router();

onboardingRouter.use(requireAuth);
onboardingRouter.use(usageGuard);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHISPER_MAX_BYTES },
});

async function loadUser(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      telegramId: true,
      onboardingStep: true,
      messageHistory: true,
      language: true,
      termsAccepted: true,
    },
  });
}

function ensureInterviewAllowed(
  user: Awaited<ReturnType<typeof loadUser>>,
  res: Response,
): boolean {
  if (!user.termsAccepted) {
    res.status(409).json({ error: "Terms must be accepted before the interview" });
    return false;
  }
  if (!user.language) {
    res.status(409).json({ error: "Language must be selected before the interview" });
    return false;
  }
  return true;
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

onboardingRouter.post("/interview/answer", agentTextLimiter, async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  const user = await loadUser(req.userId!);
  if (!ensureInterviewAllowed(user, res)) return;
  const before = await loadStateContext(req.userId!);
  const isContextDump = before.currentQuestion === "context_dump";
  const maxLength = isContextDump ? MAX_DUMP_BUFFER_CHARS : 4_000;
  if (text.length > maxLength) {
    res.status(400).json({ error: "Text is too long" });
    return;
  }

  const result = await runAgentTurn(
    user.telegramId,
    isContextDump ? { kind: "context_dump", text } : text,
  );

  const ctx = await loadStateContext(req.userId!);
  res.json(buildInterviewState({ ...ctx, question: result.reply }));
});

/**
 * POST /v1/onboarding/consent — Initialization & Consent screen.
 *
 * Records the explicit ToS click, the optional research opt-in, and the
 * client's `language` (native iOS sets it from the system locale — no
 * picker, per DESIGN). `termsAccepted` is the legal gate and MUST be the
 * boolean literal `true`; `researchOptIn` is optional (default false).
 *
 * Step transition: `consent → language`, and further to `conversational`
 * once terms + language + a verified contact rail are all in place, so the
 * server-owned fact collector (which drives the hybrid-chat `uiHint`) takes
 * over the interview. Telegram reaches `conversational` via the onboarding
 * Mini App handoff; this is the native-client equivalent. A later step is
 * never regressed (idempotent).
 */
onboardingRouter.post("/consent", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const termsAccepted = body.termsAccepted;
  const researchOptIn = body.researchOptIn;
  const language = body.language;

  if (termsAccepted !== true) {
    res.status(400).json({ error: "Terms must be accepted" });
    return;
  }
  if (researchOptIn !== undefined && typeof researchOptIn !== "boolean") {
    res.status(400).json({ error: "Invalid researchOptIn" });
    return;
  }
  if (
    language !== undefined &&
    (typeof language !== "string" || !SUPPORTED_LANGUAGES.includes(language as Language))
  ) {
    res.status(400).json({ error: "Invalid language" });
    return;
  }

  const current = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
    select: {
      onboardingStep: true,
      language: true,
      registrationTrack: true,
      phoneVerifiedAt: true,
      isEmailVerified: true,
      email: true,
    },
  });

  const nextLanguage = (language as Language | undefined) ?? current.language ?? null;
  const contactReady = hasTrackVerifiedContact(current);
  const preConversational =
    current.onboardingStep === "consent" || current.onboardingStep === "language";
  // Hand the interview to the fact collector only when everything it needs is
  // present; otherwise sit at `language` until the client sets it.
  const nextStep =
    preConversational && nextLanguage && contactReady
      ? ("conversational" as const)
      : current.onboardingStep === "consent"
        ? ("language" as const)
        : current.onboardingStep;

  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      termsAccepted: true,
      termsAcceptedAt: new Date(),
      researchOptIn: researchOptIn ?? false,
      ...(language !== undefined ? { language: language as Language } : {}),
      ...(nextStep !== current.onboardingStep ? { onboardingStep: nextStep } : {}),
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
    if (!ensureInterviewAllowed(user, res)) return;
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
