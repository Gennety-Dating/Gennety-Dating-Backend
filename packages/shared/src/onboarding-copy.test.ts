import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "./types.js";
import { contextDumpInstruction } from "./onboarding-copy.js";

describe("contextDumpInstruction", () => {
  it("keeps the canonical Russian copy exact", () => {
    expect(contextDumpInstruction("ru")).toBe(
      "Gennety использует подтверждённые сигналы из твоих диалогов, чтобы точнее подбирать кандидатов. " +
        "Промпт просит AI ничего не додумывать: если данных о какой-то стороне жизни нет, раздел останется пустым. " +
        "Такой же принцип действует для всех пользователей.\n\n" +
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

  it.each(SUPPORTED_LANGUAGES)(
    "explains the no-gap-filling rule in %s",
    (language) => {
      const instruction = contextDumpInstruction(language);
      expect(instruction).toMatch(/empty|пуст|порож|leer|pusta/i);
    },
  );
});
