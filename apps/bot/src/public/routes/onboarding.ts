import { Router, type Request, type Response } from "express";
import multer from "multer";
import { MULTIPART_FIELD_LIMITS } from "../../utils/upload-limits.js";
import { prisma } from "@gennety/db";
import {
  LEGAL_DOCS_VERSION,
  MIN_PHOTOS,
  SUPPORTED_LANGUAGES,
  type Language,
} from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { agentTextLimiter, voiceLimiter } from "../rate-limit.js";
import { env } from "../../config.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import {
  applyOnboardingFacts,
  BASICS_QUESTIONS,
  loadOnboardingBasics,
  markOnboardingField,
} from "../../services/onboarding-collector.js";
import { onboardingReactionFor } from "../../services/message-reactions.js";
import { hasTrackVerifiedContact } from "../../services/contact-verification.js";
import { transcribeVoiceResult, WHISPER_MAX_BYTES } from "../../services/whisper.js";
import { parseOnboardingBasicsPatch } from "../onboarding-basics.js";
import { serializeUser } from "./serializers.js";
import {
  buildInterviewState,
  lastAssistantMessage,
  loadStateContext,
} from "./onboarding-state.js";

export const onboardingRouter: Router = Router();

onboardingRouter.use(requireAuth);
// `usageGuard` (the daily token budget) sits on each route that can run an
// agent turn, not on the router: `/consent` writes two flags and never reaches
// the model, so it must not answer 429 (audit C-05/B-16).

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { ...MULTIPART_FIELD_LIMITS, fileSize: WHISPER_MAX_BYTES, files: 1 },
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
 * Interviews being opened right now, by user id. A second read that lands
 * mid-turn (a retry, a remounted screen) waits for the same turn instead of
 * recording the opening question twice. One bot process serves the public API.
 */
const openingInterviews = new Map<string, Promise<void>>();

/**
 * The native chat's first question (DECISIONS 2026-09-30).
 *
 * Telegram gets it from the Mini App handoff (`/complete` runs a `resume`
 * turn); the native client reaches `conversational` through `POST /consent`,
 * and nothing asked the first question there. `GET` returned an empty history
 * with no `uiHint`, and iOS drew an empty chat. The chat is opened with the
 * same `resume` turn: it records no user message, so the history starts with
 * the question, as in Telegram.
 *
 * Only once the basics are complete (same day, later): the native client asks
 * those five on its own screens and saves them through `POST /basics`, which
 * opens the chat itself on the save that completes them. Opening earlier would
 * put the "name and age" question into a chat that must start after the
 * screens. Here the open is the safety net — a completing save whose turn
 * failed, or basics finished on another rail — and the first question is
 * whatever the collector asks after the basics.
 *
 * Only the collector opens it: without the flag, a `resume` turn would reach
 * the legacy agent with an empty message. An interview that already has an
 * assistant prompt is never re-opened.
 *
 * `beforeBasics` lifts the basics wait for builds from before the screens
 * (audit C-02): they never call `POST /basics` and draw the chat from the
 * first question, so for them the chat opens on the basics question itself
 * ("name and age"), as it did before 2026-09-30, and the collector takes the
 * answers in chat. A current build is unaffected even if it gets here: it
 * routes on `basics.complete`, not on the question, and the save that
 * completes the basics clears the history and re-opens the chat (`/basics`).
 */
async function openInterviewIfUnstarted(
  userId: string,
  options: { beforeBasics?: boolean } = {},
): Promise<void> {
  const inFlight = openingInterviews.get(userId);
  if (inFlight) return inFlight;
  const opening = (async () => {
    if (!env.ONBOARDING_FACT_COLLECTOR_ENABLED) return;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        telegramId: true,
        onboardingStep: true,
        termsAccepted: true,
        language: true,
        messageHistory: true,
        registrationTrack: true,
        phoneVerifiedAt: true,
        isEmailVerified: true,
        email: true,
      },
    });
    if (
      user.onboardingStep !== "conversational" ||
      !user.termsAccepted ||
      !user.language ||
      !hasTrackVerifiedContact(user) ||
      lastAssistantMessage((user.messageHistory ?? []) as unknown[]) !== null
    ) {
      return;
    }
    if (!options.beforeBasics && !(await loadOnboardingBasics(userId)).complete) return;
    await runAgentTurn(user.telegramId, { kind: "resume" }, { canPresentTypeRadar: false });
  })();
  openingInterviews.set(userId, opening);
  try {
    await opening;
  } finally {
    openingInterviews.delete(userId);
  }
}

/**
 * A client from before the basics screens (pre-2026-09-30 builds). Builds that
 * know the screens are not distinguishable from those older ones by anything
 * they send — except the `X-Gennety-Build` header, which only builds newer
 * than both send (contract decision 2026-10-11 #3). So a request WITH the
 * header waits for the basics as designed; one without it gets the chat
 * opened at once, which an old build needs and a screens-era build tolerates
 * (see `openInterviewIfUnstarted`). The cost is one opening turn that a
 * screens-era build's basics save later discards.
 */
function isPreBasicsClient(req: Request): boolean {
  return !req.get("x-gennety-build");
}

/**
 * GET /v1/onboarding/interview
 * Returns the current step, the most recent assistant prompt and the basics
 * (`basics`). A chat the collector has not started yet is opened first once
 * the basics are complete, so the answer carries its first question
 * (`openInterviewIfUnstarted`); before that, `basics` is what the client routes
 * on. A build that predates the basics screens gets the chat opened at once
 * (`isPreBasicsClient`, audit C-02).
 */
onboardingRouter.get("/interview", usageGuard, async (req: Request, res: Response): Promise<void> => {
  try {
    await openInterviewIfUnstarted(req.userId!, { beforeBasics: isPreBasicsClient(req) });
  } catch (error) {
    // The read still answers: the client shows an unopened interview as
    // "not ready yet" with a retry, and the retry opens it.
    console.error("[onboarding] opening turn failed", {
      userId: req.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const ctx = await loadStateContext(req.userId!);
  res.json(buildInterviewState(ctx));
});

/**
 * POST /v1/onboarding/basics — the native basics screens (DECISIONS 2026-09-30).
 *
 * The native twin of the Mini App's `POST /v1/telegram-onboarding/profile`:
 * name, age, gender, preference, height and relationship intent are saved from
 * their own screens through the collector's structured path
 * (`applyOnboardingFacts`), not sent into the chat as answers. Two things the
 * founder asked for follow from that:
 *
 * - Going back is re-saving. A screen the user returns to posts its field
 *   again and the collector overwrites it — there is no undo to model, exactly
 *   like the Mini App's back button.
 * - The chat starts from scratch. The basics never enter `messageHistory`, and
 *   the save that completes them opens the chat with the collector's `resume`
 *   turn, so it starts on the first free question, as Telegram does after the
 *   Mini App. History recorded before that moment — an account that began the
 *   basics in the old in-chat flow, or a stray opener typed into an empty chat
 *   — is dropped then: it is the same questions the screens just answered.
 *
 * Same body and error codes as the Mini App route (`parseOnboardingBasicsPatch`),
 * all-or-nothing: a rejected value writes nothing and answers 400
 * `{error, field}` with the collector's reason.
 */
onboardingRouter.post("/basics", usageGuard, async (req: Request, res: Response): Promise<void> => {
  const user = await loadUser(req.userId!);
  if (!ensureInterviewAllowed(user, res)) return;
  if (user.onboardingStep !== "conversational") {
    res.status(409).json({ error: "interview-not-open" });
    return;
  }
  const parsed = parseOnboardingBasicsPatch((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (Object.keys(parsed.facts).length === 0) {
    res.status(400).json({ error: "no-fields" });
    return;
  }

  const before = await loadOnboardingBasics(req.userId!);
  const snapshot = await applyOnboardingFacts(user.telegramId, parsed.facts);
  const rejection = snapshot.rejectedFields[0];
  if (rejection) {
    res.status(400).json({ error: rejection.reason, field: rejection.field });
    return;
  }

  if (!before.complete && !BASICS_QUESTIONS.has(snapshot.currentQuestion)) {
    await prisma.user.update({
      where: { id: req.userId! },
      data: { messageHistory: [] },
    });
    try {
      await openInterviewIfUnstarted(req.userId!);
    } catch (error) {
      // The basics are saved either way. The chat then reads as unopened, and
      // the client's retry is a `GET`, which opens it.
      console.error("[onboarding] opening turn after basics failed", {
        userId: req.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ctx = await loadStateContext(req.userId!);
  res.json(buildInterviewState(ctx));
});

onboardingRouter.post("/interview/answer", usageGuard, agentTextLimiter, async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  const user = await loadUser(req.userId!);
  if (!ensureInterviewAllowed(user, res)) return;
  if (text.length > 4_000) {
    res.status(400).json({ error: "Text is too long" });
    return;
  }

  const result = await runAgentTurn(
    user.telegramId,
    text,
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
  usageGuard,
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
 * POST /v1/onboarding/photos/continue — leave the native photo stage
 * (DECISIONS 2026-09-30, the photo manager).
 *
 * The native twin of Telegram's "Continue ➡️" (`photos_continue`). The stage
 * used to close by itself on the upload that reached the minimum — each upload
 * ran an agent turn, and at four photos the collector moved on or finalized —
 * so the native client could neither add a fifth photo nor swap one it had
 * second thoughts about. Now uploads at this stage run no turn, the stage stays
 * open (`expectingPhoto`) until the user leaves it here, and this is where the
 * collector moves on: `photos` is recorded, then the same `photos_continue`
 * turn as Telegram asks the next question or finalizes. Recording the field
 * also sets the delete floor for the rest of onboarding (`DELETE
 * /v1/me/photos/:index`).
 *
 * 409 `photos-required` below the minimum. Idempotent: off this question (a
 * retry whose first attempt landed) it changes nothing and returns the state.
 */
onboardingRouter.post(
  "/photos/continue",
  usageGuard,
  agentTextLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const user = await loadUser(req.userId!);
    if (!ensureInterviewAllowed(user, res)) return;

    const before = await loadStateContext(req.userId!);
    if (before.step !== "conversational" || before.currentQuestion !== "photos") {
      res.json(buildInterviewState(before));
      return;
    }
    if (before.photoCount < MIN_PHOTOS) {
      res.status(409).json({ error: "photos-required", minPhotos: MIN_PHOTOS });
      return;
    }

    await markOnboardingField(user.telegramId, "photos");
    const result = await runAgentTurn(
      user.telegramId,
      { kind: "photos_continue" },
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
  usageGuard,
  voiceLimiter,
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }

    const user = await loadUser(req.userId!);
    if (!ensureInterviewAllowed(user, res)) return;
    const transcription = await transcribeVoiceResult(req.file.buffer, {
      mime: req.file.mimetype,
      ...(user.language ? { language: user.language } : {}),
    });
    // An outage is not the recording's fault: 503 keeps the note on the
    // device for a retry, 422 would discard it (audit C-06).
    if (!transcription.ok && transcription.reason === "unavailable") {
      res.status(503).json({ error: "transcription_unavailable" });
      return;
    }
    const transcript = transcription.ok ? transcription.text : "";
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
