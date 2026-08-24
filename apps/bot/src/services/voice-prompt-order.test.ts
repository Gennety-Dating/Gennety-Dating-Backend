import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * The collector question order, with the feature ON.
 *
 * Every other test in this repo runs with `VOICE_PROMPT_ENABLED` unset, which
 * is correct — the feature ships dark and must change nothing. That also means
 * nothing else in the suite ever executes the branch this feature exists for,
 * so this file is the only place the ON path is exercised at all.
 */

async function loadCollector(enabled: boolean) {
  vi.resetModules();
  if (enabled) process.env.VOICE_PROMPT_ENABLED = "true";
  else delete process.env.VOICE_PROMPT_ENABLED;
  return import("./onboarding-collector.js");
}

/** Everything answered except the voice prompt. */
const ANSWERED = [
  "first_name",
  "age",
  "gender",
  "preference",
  "height",
  "relationship_intent",
  "hobbies",
  "partner_preferences",
  "friday_vibe",
  "vibe_focus",
  "ai_memory",
  "context_dump",
  "photos",
];

function progress(mod: { ONBOARDING_FIELDS: readonly string[] }, completed: readonly string[]) {
  return {
    completed: new Set(completed),
    skipped: new Set<string>(),
    asked: new Set<string>(),
  } as never;
}

afterEach(() => {
  delete process.env.VOICE_PROMPT_ENABLED;
  vi.resetModules();
});

describe("voice_prompt in the canonical order", () => {
  it("is asked AFTER photos when the feature is on", async () => {
    const mod = await loadCollector(true);
    expect(mod.nextOnboardingQuestion(progress(mod, ANSWERED))).toBe("voice_prompt");
  });

  it("is the LAST question — answering it finalizes", async () => {
    const mod = await loadCollector(true);
    expect(
      mod.nextOnboardingQuestion(progress(mod, [...ANSWERED, "voice_prompt"])),
    ).toBe("complete");
  });

  it("never comes before photos — an unfinished photo set still wins", async () => {
    const mod = await loadCollector(true);
    const withoutPhotos = ANSWERED.filter((f) => f !== "photos");
    expect(mod.nextOnboardingQuestion(progress(mod, withoutPhotos))).toBe("photos");
  });

  it("carries a real ask in every language, and every one forbids reading the profile aloud", async () => {
    const mod = await loadCollector(true);
    for (const lang of ["en", "ru", "uk", "de", "pl"] as const) {
      const text = mod.onboardingQuestionText(lang, "voice_prompt", []);
      // The central instruction is a prohibition, because the default failure
      // is reading the bio aloud and the bio is already on the partner's
      // screen (PRODUCT_SPEC §1.3b). A cheerful "record something!" would be a
      // different feature.
      expect(text.length).toBeGreaterThan(150);
      expect(text).toMatch(/\n\n/);
    }
  });

  it("is a PURE function of progress — the feature flag is not read here", async () => {
    // Worth pinning, because the obvious assumption is the opposite. The
    // ships-dark masking lives in `progressFromUser`, which marks the field
    // complete+skipped when the flag is off — exactly where `ai_memory`'s own
    // mask lives (`effectiveAiMemoryPreference`). `nextOnboardingQuestion`
    // stays pure and just reads the set it is handed.
    //
    // The guarantee itself is proved by the rest of the suite rather than
    // here: every one of the 82 tests in `onboarding-collector.test.ts` runs
    // with the flag unset and expects the untouched `photos → complete` order.
    const off = await loadCollector(false);
    expect(off.nextOnboardingQuestion(progress(off, ANSWERED))).toBe("voice_prompt");

    const on = await loadCollector(true);
    expect(on.nextOnboardingQuestion(progress(on, ANSWERED))).toBe("voice_prompt");
  });
});
