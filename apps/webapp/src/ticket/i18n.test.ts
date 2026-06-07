import { describe, expect, it } from "vitest";
import { pickLang, strings, type Lang } from "./i18n.js";

const languages: Lang[] = ["en", "ru", "uk", "de", "pl"];

describe("Date Ticket i18n", () => {
  it("has a complete distinct dictionary for every supported language", () => {
    for (const lang of languages) {
      expect(pickLang(lang)).toBe(lang);
      expect(strings(lang).heading.length).toBeGreaterThan(0);
      expect(strings(lang).ticketStub.length).toBeGreaterThan(0);
      expect(strings(lang).matchFallback.length).toBeGreaterThan(0);
    }
    expect(strings("de").heading).not.toBe(strings("en").heading);
    expect(strings("pl").heading).not.toBe(strings("en").heading);
  });
});
