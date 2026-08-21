import type { SessionData } from "@gennety/shared";
import { env } from "../config.js";

/**
 * Does this chat currently owe a voice-prompt recording?
 *
 * One predicate, two readers, and that is the whole point of the module: it is
 * consulted by `handlers/voice.ts` — which is mounted ahead of every router and
 * would otherwise swallow the recording — and by the onboarding router that
 * actually ingests it. Two copies of this condition would eventually disagree,
 * and the failure mode of disagreement is silent: the transcript reaches the
 * fact collector as if the user had typed it, and a sentence about a hobby is
 * mined into their profile.
 *
 * Three conditions, each load-bearing:
 *
 * - **The flag.** With voice prompts off the collector never asks, so a live
 *   flag on an old session must not make `voiceHandler` hand a voice note to a
 *   handler that no longer exists. Reading it here means switching the feature
 *   off is complete rather than partial.
 * - **The session claim**, set when the question is asked and cleared by an
 *   answer, a skip, or finalization.
 * - **Onboarding is not finished.** Belt to the claim's braces: the flag is
 *   cleared on every exit from the step, but a session written before this
 *   field existed reads `false` and a session that somehow survived
 *   finalization would otherwise capture every voice note the user ever sends
 *   to the concierge. Post-onboarding voice is the assistant's, always.
 */
export function isAwaitingVoicePrompt(session: SessionData): boolean {
  if (!env.VOICE_PROMPT_ENABLED) return false;
  if (session.onboardingStep === "completed") return false;
  return session.expectingVoicePrompt === true;
}

/** Ask for a recording: the step now owns incoming voice. */
export function claimVoicePrompt(session: SessionData): void {
  session.expectingVoicePrompt = true;
}

/** Recorded, skipped, or the flow moved on. */
export function releaseVoicePrompt(session: SessionData): void {
  session.expectingVoicePrompt = false;
}
