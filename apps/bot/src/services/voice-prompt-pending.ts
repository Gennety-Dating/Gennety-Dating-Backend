import { prisma } from "@gennety/db";
import { env } from "../config.js";
import type { SessionData } from "@gennety/shared";


export async function isVoicePromptQuestionPending(telegramId: bigint): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { onboardingProgress: { select: { currentQuestion: true } } },
    });
    return user?.onboardingProgress?.currentQuestion === "voice_prompt";
  } catch (err) {
    // Degrade to the session flag alone. A failure here means the turn that
    // follows is broken anyway — `runAgentTurn` reads the same row — so the
    // honest outcome is today's behaviour rather than routing a recording to
    // an ingest that was never asked for.
    console.warn("[voice-prompt] pending lookup failed:", err);
    return false;
  }
}

/**
 * Should this chat's voice note be left for the voice-prompt step?
 *
 * Ordered so the DB is touched last and rarely: the flag, then the session
 * claim, then onboarding state, then the collector. Returns true only for the
 * derived case — the caller already handled a live claim.
 */
export async function shouldClaimVoiceFromCollector(
  session: SessionData,
  telegramId: bigint,
): Promise<boolean> {
  if (!env.VOICE_PROMPT_ENABLED) return false;
  if (session.expectingVoicePrompt === true) return false;
  if (session.onboardingStep === "completed") return false;
  return isVoicePromptQuestionPending(telegramId);
}
