import { prisma, type OnboardingStep } from "@gennety/db";
import { MIN_PHOTOS } from "@gennety/shared";
import { uiHintForQuestion, type UiHint } from "../ui-hints.js";

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
}

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

function lastAssistantMessage(history: unknown[]): string | null {
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
    messages,
    expectingPhoto,
    photoCount: ctx.photoCount,
    minPhotos: MIN_PHOTOS,
    uiHint,
  };
}

export async function loadStateContext(userId: string): Promise<StateContext> {
  const [user, profile, progress] = await Promise.all([
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
  ]);
  return {
    step: user.onboardingStep,
    history: (user.messageHistory ?? []) as unknown[],
    photoCount: profile?.photos?.length ?? 0,
    currentQuestion: progress?.currentQuestion ?? null,
  };
}
