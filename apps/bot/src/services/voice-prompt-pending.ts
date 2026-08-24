import { prisma } from "@gennety/db";
import { env } from "../config.js";
import type { SessionData } from "@gennety/shared";

/**
 * The backstop under the session claim: is the COLLECTOR standing on the
 * voice-prompt question right now?
 *
 * `services/voice-prompt-claim.ts` is the fast path and the session flag it
 * reads is armed when the ask is sent. That was written when the ask had one
 * sender. It does not: an onboarding agent reply reaches Telegram from nine
 * places (`/start`'s resume, the photo-batch flush, the photo editor, the
 * context-dump flush, the radar resume, …), and every one of them delivers
 * `result.reply` with its own call. A sender that forgets to arm the claim is
 * therefore not a hypothetical — it was the shipped state, and the photo-batch
 * flush, which asks this question first in the ordinary flow, was one of them.
 *
 * What that costs is not a missing button. `voiceHandler` is mounted ahead of
 * every router: with no claim it hands the recording to Whisper, writes the
 * transcript into `ctx.message.text`, and the fact collector mines it. The
 * question itself never resolves — `voice_prompt` is synthetic and cannot be
 * satisfied by text — so the agent asks again, forever, while the rest of the
 * transcript is written into the profile. Observed live: one turn recorded
 * `accepted: [ 'gender', 'preference' ]` out of a voice prompt.
 *
 * So the claim is derived from state that no sender can forget, and the flag
 * becomes an optimization rather than the guarantee. `currentQuestion` is the
 * collector's own answer to "which question is pending" — the same field
 * `runAgentTurn` routes on — so the two cannot disagree about the step.
 *
 * Cost: one indexed lookup per voice note, and only for a chat that is (a) mid
 * onboarding and (b) has no claim already. Post-onboarding voice — every voice
 * note the concierge ever receives — pays nothing, because the caller checks
 * the cheap conditions first.
 */
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
