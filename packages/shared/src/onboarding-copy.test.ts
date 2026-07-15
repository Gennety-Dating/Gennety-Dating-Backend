import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "./types.js";
import { contextDumpInstruction } from "./onboarding-copy.js";

describe("contextDumpInstruction", () => {
  it("keeps the canonical Russian copy exact", () => {
    expect(contextDumpInstruction("ru")).toBe(
      "Gennety анализирует твои диалоги и на их основе подбирает кандидатов. " +
        "Чем больше контекста — от главных ценностей до мелких деталей, — " +
        "тем точнее твой психологический профиль. " +
        "Такой же глубокий опрос проходит каждый, так что совместимость пары — не случайность.\n\n" +
        "Скопируй промпт выше, вставь его в ChatGPT, Claude, Gemini или любой " +
        "другой AI-чат, а потом скинь мне полный ответ.",
    );
  });

  it.each(SUPPORTED_LANGUAGES)(
    "provides the canonical instruction family in %s",
    (language) => {
      const instruction = contextDumpInstruction(language);

      expect(instruction).toContain("Gennety");
      expect(instruction).not.toContain("Telegram");
      expect(instruction).not.toContain("Magic Prompt");
    },
  );

  it("falls back to English when no language is available", () => {
    expect(contextDumpInstruction(undefined)).toBe(
      contextDumpInstruction("en"),
    );
  });
});
