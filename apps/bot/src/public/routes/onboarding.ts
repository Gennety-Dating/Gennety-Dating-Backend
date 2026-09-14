import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "@gennety/db";
import {
  LEGAL_DOCS_VERSION,
  MAX_DUMP_BUFFER_CHARS,
  SUPPORTED_LANGUAGES,
  type Language,
} from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { agentTextLimiter, voiceLimiter } from "../rate-limit.js";
import { env } from "../../config.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { markOnboardingField } from "../../services/onboarding-collector.js";
import { onboardingReactionFor } from "../../services/message-reactions.js";
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
  // A finished onboarding has no interview left to answer, and running one
  // anyway handed a completed account the legacy agent and its email tools —
  // the path that let a verified user swap in an unproven address (audit
  // A13-C1). Reads (`GET /interview`) stay open; only turns are refused.
  if (user.onboardingStep === "completed") {
    res.status(409).json({ error: "Onboarding is already complete" });
    return false;
  }
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
    // The Type Radar is a Telegram Mini App behind `initData` auth, so this
    // client cannot open it — see `AgentDeps.canPresentTypeRadar`.
    { canPresentTypeRadar: false },
  );

  const ctx = await loadStateContext(req.userId!);
  res.json(
    buildInterviewState({
      ...ctx,
      question: result.reply,
      reaction: onboardingReactionFor(result.acceptedOnboardingFields),
    }),
  );
});

/**
 * POST /v1/onboarding/interview/voice-prompt — leave the voice step
 * (`uiHint.control = "voice_record"`), kept or skipped.
 *
 * The native twin of the Telegram step's single exit (`exitVoiceStep` in
 * `handlers/onboarding/voice-prompt.ts`): mark the field, then hand the
 * conversation back to the collector with a `resume` turn so it finalizes —
 * the same path the photo stage takes, never a direct finalize (PRODUCT_SPEC
 * §1.3 records what calling it directly cost). Without it a native account was
 * stranded on this question once the flag went on: the recording is committed
 * through `/v1/me/voice-prompt`, which knows nothing about onboarding, and
 * there was no skip at all.
 *
 * The client does not say which exit it took, the row does: a saved recording
 * is "kept", no recording is "skipped". That keeps the two truths from ever
 * disagreeing — a client that skipped after a failed upload cannot record a
 * "kept" over nothing.
 *
 * Idempotent: called when the collector is no longer on this question (a
 * retried request whose first attempt landed) it changes nothing and returns
 * the current state.
 */
onboardingRouter.post(
  "/interview/voice-prompt",
  agentTextLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!env.VOICE_PROMPT_ENABLED) {
      res.status(404).json({ error: "voice-prompt-disabled" });
      return;
    }
    const user = await loadUser(req.userId!);
    if (!ensureInterviewAllowed(user, res)) return;

    const before = await loadStateContext(req.userId!);
    if (before.step !== "conversational" || before.currentQuestion !== "voice_prompt") {
      res.json(buildInterviewState(before));
      return;
    }

    const recording = await prisma.voicePrompt.findUnique({
      where: { userId: req.userId! },
      select: { id: true },
    });
    await markOnboardingField(user.telegramId, "voice_prompt", recording === null);
    const result = await runAgentTurn(
      user.telegramId,
      { kind: "resume" },
      { canPresentTypeRadar: false },
    );

    const ctx = await loadStateContext(req.userId!);
    res.json(buildInterviewState({ ...ctx, question: result.reply }));
  },
);

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
      // Art. 7(1): record WHAT was accepted, not just when.
      policyVersion: LEGAL_DOCS_VERSION,
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

    const result = await runAgentTurn(user.telegramId, transcript, {
      canPresentTypeRadar: false,
    });
    const ctx = await loadStateContext(req.userId!);
    res.json(
      buildInterviewState({
        ...ctx,
        question: result.reply,
        acknowledgement: transcript,
        reaction: onboardingReactionFor(result.acceptedOnboardingFields),
      }),
    );
  },
);
