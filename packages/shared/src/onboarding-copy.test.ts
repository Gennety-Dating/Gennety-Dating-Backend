import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "./types.js";
import { contextDumpInstruction } from "./onboarding-copy.js";

describe("contextDumpInstruction", () => {
  it.each(SUPPORTED_LANGUAGES)(
    "provides canonical Magic Prompt guidance in %s",
    (language) => {
      const instruction = contextDumpInstruction(language);

      expect(instruction).toContain("Magic Prompt");
      expect(instruction).not.toContain("Telegram");
    },
  );

  it("falls back to English when no language is available", () => {
    expect(contextDumpInstruction(undefined)).toBe(
      contextDumpInstruction("en"),
    );
  });
});
