import { prisma, type OnboardingStep } from "@gennety/db";
import {
  MAX_AGE,
  MAX_HEIGHT_CM,
  MIN_AGE,
  MIN_HEIGHT_CM,
  MIN_PHOTOS,
} from "@gennety/shared";
import { uiHintForQuestion, type UiHint } from "../ui-hints.js";
import type { OnboardingReaction } from "../../services/message-reactions.js";
import {
  loadOnboardingBasics,
  type OnboardingBasics,
} from "../../services/onboarding-collector.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface InterviewStateDto {
  stepIndex: number;
  totalSteps: number;
  question: string | null;
  completed: boolean;
  acknowledgement?: string | null;
  messages: ChatTurn[];
  expectingPhoto: boolean;
  photoCount: number;
  minPhotos: number;
  /**
   * Which native inline control the hybrid-chat client should render for
   * the current question (see `public/ui-hints.ts`). Null → plain text
   * field. Derived deterministically from the collector's
   * `currentQuestion`; null for legacy pre-collector users.
   */
  uiHint: UiHint | null;
  /**
   * The bot's reaction to the user message that this state answers — the
   * native equivalent of the Telegram message reaction (`like` 👍 on the
   * hobbies answer, `heart` ❤ on the closing vibe answer). Present only in
   * the response to an answer; `GET` state never carries it, because the
   * reaction is an event on the exchange, not a property of the history.
   */
  reaction?: OnboardingReaction;
  /**
   * The five basics the native client asks on its own screens before the chat
   * (DECISIONS 2026-09-30) — saved values, the collector's `complete` verdict
   * and the bounds of the two wheels. The native twin of the Mini App's
   * `/state.profileBasics` + `profileLimits`: the client routes to the first
   * empty screen, goes back through saved ones, and opens the chat only once
   * `complete` is true.
   */
  basics?: OnboardingBasicsDto;
}

export interface OnboardingBasicsDto extends OnboardingBasics {
  limits: { minAge: number; maxAge: number; minHeightCm: number; maxHeightCm: number };
}

const BASICS_LIMITS: OnboardingBasicsDto["limits"] = {
  minAge: MIN_AGE,
  maxAge: MAX_AGE,
  minHeightCm: MIN_HEIGHT_CM,
  maxHeightCm: MAX_HEIGHT_CM,
};

const STEP_ORDER: OnboardingStep[] = ["consent", "language", "conversational", "completed"];

interface RawHistoryMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

function chatMessages(history: unknown[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const m of history) {
    const msg = m as RawHistoryMessage | null;
    if (!msg) continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string" || msg.content.trim() === "") continue;
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

function hasPhotoRequest(history: unknown[]): boolean {
  for (const m of history) {
    const msg = m as RawHistoryMessage | null;
    const tools = msg?.tool_calls;
    if (!tools) continue;
    for (const tc of tools) {
      if (tc.function?.name === "request_photos") return true;
    }
  }
  return false;
}

export function lastAssistantMessage(history: unknown[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as { role?: string; content?: string } | null;
    if (msg?.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content;
    }
  }
  return null;
}

export interface StateContext {
  step: OnboardingStep;
  history: unknown[];
  photoCount: number;
  currentQuestion?: string | null;
  question?: string | null;
  acknowledgement?: string | null;
  reaction?: OnboardingReaction | null;
  basics?: OnboardingBasics | null;
}

export function buildInterviewState(ctx: StateContext): InterviewStateDto {
  const messages = chatMessages(ctx.history);
  const question = ctx.question ?? lastAssistantMessage(ctx.history);
  const expectingPhoto =
    ctx.step === "conversational" &&
    ctx.photoCount < MIN_PHOTOS &&
    (ctx.currentQuestion === "photos" || hasPhotoRequest(ctx.history));

  // The photo gate can be active (legacy `request_photos` tool call) even
  // when `currentQuestion` lags behind — prefer the observable state.
  const uiHint = expectingPhoto
    ? uiHintForQuestion("photos")
    : ctx.step === "conversational"
      ? uiHintForQuestion(ctx.currentQuestion)
      : null;

  return {
    stepIndex: STEP_ORDER.indexOf(ctx.step),
    totalSteps: STEP_ORDER.length,
    question,
    completed: ctx.step === "completed",
    ...(ctx.acknowledgement !== undefined ? { acknowledgement: ctx.acknowledgement } : {}),
    // Absent, not null, when there is no reaction: `enum: [..., null]` in the
    // spec makes the Swift generator emit a phantom `_empty_` case.
    ...(ctx.reaction ? { reaction: ctx.reaction } : {}),
    ...(ctx.basics ? { basics: { ...ctx.basics, limits: BASICS_LIMITS } } : {}),
    messages,
    expectingPhoto,
    photoCount: ctx.photoCount,
    minPhotos: MIN_PHOTOS,
    uiHint,
  };
}

export async function loadStateContext(userId: string): Promise<StateContext> {
  const [user, profile, progress, basics] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        telegramId: true,
        onboardingStep: true,
        messageHistory: true,
        language: true,
      },
    }),
    prisma.profile.findUnique({
      where: { userId },
      select: { photos: true },
    }),
    prisma.onboardingProgress.findUnique({
      where: { userId },
      select: { currentQuestion: true },
    }),
    loadOnboardingBasics(userId),
  ]);
  return {
    step: user.onboardingStep,
    history: (user.messageHistory ?? []) as unknown[],
    photoCount: profile?.photos?.length ?? 0,
    currentQuestion: progress?.currentQuestion ?? null,
    basics,
  };
}
