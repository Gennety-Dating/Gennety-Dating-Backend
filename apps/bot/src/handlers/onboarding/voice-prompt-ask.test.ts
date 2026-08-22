import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES, t, type Language } from "@gennety/shared";
import { onboardingQuestionText } from "../../services/onboarding-collector.js";
import { voicePromptAskText } from "./voice-prompt.js";

/**
 * The voice-prompt ask has two properties that fail SILENTLY when broken, which
 * is how both of them shipped:
 *
 *  - it claims the step is optional and never says where the exit is;
 *  - it names a duration and then asks for something that does not fit in it.
 *
 * Neither throws, neither shows up in a log, and the second is only visible to
 * someone reading the message in a language they speak. So both are pinned here.
 */
describe("voice-prompt ask", () => {
  const languages = SUPPORTED_LANGUAGES as readonly Language[];

  it("points at the skip button by its real label, in every language", () => {
    for (const language of languages) {
      const label = t(language, "voicePromptSkipButton");
      const ask = voicePromptAskText(
        language,
        onboardingQuestionText(language, "voice_prompt"),
      );
      expect(ask, language).toContain(label);
    }
  });

  it("keeps the button out of the SHARED question text", () => {
    // `runAgentTurn` returns this string to the native rail over
    // `/v1/onboarding/interview`, where this keyboard does not exist. A Telegram
    // button named there is an instruction the iOS user cannot follow.
    for (const language of languages) {
      const question = onboardingQuestionText(language, "voice_prompt");
      for (const other of languages) {
        expect(question, `${language} names ${other}'s button`).not.toContain(
          t(other, "voicePromptSkipButton"),
        );
      }
    }
  });

  it("names exactly one duration, and the same one in every language", () => {
    // The founder's report: "15 seconds" alongside "the story you always tell
    // your friends". A story is not a testable property; two different numbers
    // in one message is, and so is one language drifting away from the rest.
    for (const language of languages) {
      const numbers = onboardingQuestionText(language, "voice_prompt").match(/\d+/g) ?? [];
      expect(numbers, language).toEqual(["15"]);
    }
  });

  it("still carries the stake and the prohibition", () => {
    // The two things §4.1 says the message exists to do. Length is the pressure
    // this copy is under, so the parts worth keeping are pinned by shape rather
    // than by wording: the ask stays multi-paragraph and stays short.
    for (const language of languages) {
      const question = onboardingQuestionText(language, "voice_prompt");
      const paragraphs = question.split("\n\n");
      expect(paragraphs.length, language).toBeGreaterThanOrEqual(3);
      expect(question.length, language).toBeLessThan(460);
    }
  });
});
