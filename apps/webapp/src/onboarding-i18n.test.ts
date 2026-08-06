import { describe, expect, it } from "vitest";
import { initialOnboardingLanguage, onboardingStrings } from "./onboarding-i18n.js";
import type { Lang } from "./i18n.js";

const languages: Lang[] = ["en", "ru", "uk", "de", "pl"];

describe("onboarding i18n", () => {
  it("prefers the URL language and falls back to Telegram language", () => {
    expect(initialOnboardingLanguage("pl", "de")).toBe("pl");
    expect(initialOnboardingLanguage(null, "de")).toBe("de");
    expect(initialOnboardingLanguage(null, "fr")).toBe("en");
  });

  it("provides every dynamic onboarding label in all supported languages", () => {
    for (const lang of languages) {
      const s = onboardingStrings(lang);
      const typewriterFields = [
        s.wasteLines,
        s.burnoutLines,
        s.cost2026Lines,
        s.statHookLines,
      ];
      for (const field of typewriterFields) {
        expect(field.length).toBeGreaterThan(0);
        for (const line of field) {
          expect(line.length).toBeGreaterThan(0);
          for (const part of line) expect(part.length).toBeGreaterThan(0);
        }
      }
      // The stat-hook line is a single typed line (the "statistically," opener
      // and its pause were removed), so no comma split remains.
      expect(s.statHookLines[0]).toHaveLength(1);
      expect(s.pivotLines).toHaveLength(2);
      for (const line of s.pivotLines) {
        expect(line.length).toBeGreaterThan(0);
        for (const part of line) expect(part.length).toBeGreaterThan(0);
      }
      expect(s.matchmakerLines).toHaveLength(1);
      for (const line of s.matchmakerLines) {
        expect(line.length).toBeGreaterThan(0);
        for (const part of line) expect(part.length).toBeGreaterThan(0);
      }
      expect(s.howItWorksSteps).toHaveLength(3);
      for (const step of s.howItWorksSteps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.body.length).toBeGreaterThan(0);
      }
      expect(s.dateFlowSteps).toHaveLength(6);
      for (const step of s.dateFlowSteps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.body.length).toBeGreaterThan(0);
      }
      expect(s.more.length).toBeGreaterThan(0);
      expect(s.exhaustionLines).toHaveLength(4);
      expect(s.statLabels).toHaveLength(3);
      expect(s.consentTitle.length).toBeGreaterThan(0);
      expect(s.emailTitle.length).toBeGreaterThan(0);
      expect(s.otpLead("student@example.edu")).toContain("student@example.edu");
      expect(s.cityTitle.length).toBeGreaterThan(0);
      expect(s.aiMemoryTitle.length).toBeGreaterThan(0);
      expect(s.doneTitle.length).toBeGreaterThan(0);
      expect(s.errors["invalid-email"]?.length).toBeGreaterThan(0);
      // Profile screens (PRODUCT_SPEC §1.3). Key parity is enforced by the
      // `OnboardingStrings` type on each locale block; this catches an empty
      // placeholder left behind in one of them.
      for (const value of [
        s.basicsNameTitle,
        s.basicsNamePlaceholder,
        s.basicsAgeTitle,
        s.basicsGenderTitle,
        s.basicsGenderMale,
        s.basicsGenderFemale,
        s.basicsPreferenceTitle,
        s.basicsPreferenceMen,
        s.basicsPreferenceWomen,
        s.basicsPreferenceBoth,
        s.basicsHeightTitle,
        s.basicsHeightUnit,
      ]) {
        expect(value.length).toBeGreaterThan(0);
      }
      // The server answers a bad value with its machine reason, so the client
      // must be able to translate the three a user can actually trigger.
      for (const reason of ["invalid_name", "age_out_of_range", "height_out_of_range"]) {
        expect(s.errors[reason]?.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not fall back to English for German and Polish core copy", () => {
    expect(onboardingStrings("de").consentTitle).not.toBe(onboardingStrings("en").consentTitle);
    expect(onboardingStrings("pl").aiMemoryTitle).not.toBe(onboardingStrings("en").aiMemoryTitle);
    expect(onboardingStrings("de").basicsAgeTitle).not.toBe(
      onboardingStrings("en").basicsAgeTitle,
    );
    expect(onboardingStrings("pl").basicsHeightTitle).not.toBe(
      onboardingStrings("en").basicsHeightTitle,
    );
  });
});
