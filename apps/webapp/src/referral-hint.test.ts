import { describe, it, expect } from "vitest";
import { referralHintText, type ReferralLang } from "./referral-hint";

const LANGS: ReferralLang[] = ["en", "ru", "uk", "de", "pl"];

/**
 * The chip exists because the row it replaced wrapped to two lines on every
 * phone — 59 characters at 13px/600 against ~350px of usable width. A chip that
 * wraps is the same block again under a rounder corner, so the length budget is
 * the load-bearing property, not the styling.
 *
 * 31 characters is the bound: at 12.5px/600 that is ~205px, and the chip's own
 * chrome (14px envelope + 7px gap + 14px padding either side) costs 49px, which
 * together clears a 320px screen with 20px page padding — the narrowest device
 * any of these Mini Apps is opened on.
 */
const ONE_LINE_MAX = 31;

describe("referral cross-promo copy", () => {
  it("fits one line in every language", () => {
    for (const lang of LANGS) {
      const text = referralHintText(lang);
      expect(text.length, `${lang}: "${text}"`).toBeLessThanOrEqual(ONE_LINE_MAX);
      expect(text).not.toContain("\n");
      expect(text.trim()).toBe(text);
    }
  });

  it("is a statement, not a question", () => {
    // "Не хватает билетов? Пригласи друга…" read as a nagging banner: the
    // question mark makes the reader answer before they can skip the line.
    for (const lang of LANGS) {
      expect(referralHintText(lang), lang).not.toContain("?");
    }
  });

  it("is translated in every supported language", () => {
    const texts = LANGS.map(referralHintText);
    expect(new Set(texts).size).toBe(LANGS.length);
  });

  it("falls back to English for an unknown language", () => {
    expect(referralHintText("fr" as ReferralLang)).toBe(referralHintText("en"));
  });
});
