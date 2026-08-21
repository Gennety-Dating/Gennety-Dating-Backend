import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SESSION, type SessionData } from "@gennety/shared";

/**
 * The claim that keeps `voiceHandler` from eating the recording.
 *
 * `voiceHandler` is mounted at `bot.ts` ahead of every router and rewrites
 * `ctx.message.text` with a Whisper transcript. Without this predicate the
 * voice note the user was just asked for arrives at the fact collector as a
 * typed sentence — so these are not style tests, they are the feature.
 */

function sessionWith(patch: Partial<SessionData>): SessionData {
  return { ...DEFAULT_SESSION, ...patch } as SessionData;
}

describe("isAwaitingVoicePrompt", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.VOICE_PROMPT_ENABLED;
    vi.resetModules();
  });

  async function load() {
    return (await import("./voice-prompt-claim.js")).isAwaitingVoicePrompt;
  }

  it("claims the recording while the step is waiting", async () => {
    process.env.VOICE_PROMPT_ENABLED = "true";
    const isAwaiting = await load();
    expect(
      isAwaiting(sessionWith({ expectingVoicePrompt: true, onboardingStep: "conversational" })),
    ).toBe(true);
  });

  it("claims nothing when the feature is off, even on a session that still says it is waiting", async () => {
    // Switching the feature off must be complete, not partial: an old session
    // carrying the flag would otherwise route a voice note to a step the
    // collector no longer asks.
    process.env.VOICE_PROMPT_ENABLED = "false";
    const isAwaiting = await load();
    expect(
      isAwaiting(sessionWith({ expectingVoicePrompt: true, onboardingStep: "conversational" })),
    ).toBe(false);
  });

  it("never claims after onboarding is finished — post-onboarding voice is the concierge's", async () => {
    process.env.VOICE_PROMPT_ENABLED = "true";
    const isAwaiting = await load();
    expect(
      isAwaiting(sessionWith({ expectingVoicePrompt: true, onboardingStep: "completed" })),
    ).toBe(false);
  });

  it("does not claim an ordinary voice note mid-onboarding", async () => {
    process.env.VOICE_PROMPT_ENABLED = "true";
    const isAwaiting = await load();
    expect(
      isAwaiting(sessionWith({ expectingVoicePrompt: false, onboardingStep: "conversational" })),
    ).toBe(false);
  });

  it("reads a session written before the field existed as not-waiting (fails closed)", async () => {
    process.env.VOICE_PROMPT_ENABLED = "true";
    const isAwaiting = await load();
    const legacy = { ...DEFAULT_SESSION, onboardingStep: "conversational" } as SessionData;
    delete (legacy as Partial<SessionData>).expectingVoicePrompt;
    expect(isAwaiting(legacy)).toBe(false);
  });
});
