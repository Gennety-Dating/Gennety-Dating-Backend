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
      // Scene 8 intro + gender selector + chat demo copy: everything per language.
      expect(s.matchDemo.introBullets).toHaveLength(3);
      for (const partner of [s.matchDemo.man, s.matchDemo.woman]) {
        expect(partner.name.length).toBeGreaterThan(0);
        expect(partner.age).toBeGreaterThan(0);
        expect(partner.tagline.length).toBeGreaterThan(0);
        expect(partner.question.length).toBeGreaterThan(0);
      }
      for (const field of [
        s.matchDemo.introTitle,
        ...s.matchDemo.introBullets,
        s.matchDemo.choosePrompt,
        s.matchDemo.chooseWoman,
        s.matchDemo.chooseMan,
        s.matchDemo.userYes,
        s.matchDemo.confirmLead,
        s.matchDemo.confirmGo,
        s.matchDemo.goBack,
        s.matchDemo.waiting,
        s.matchDemo.mutual,
      ]) {
        expect(field.length).toBeGreaterThan(0);
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
    }
  });

  it("does not fall back to English for German and Polish core copy", () => {
    expect(onboardingStrings("de").consentTitle).not.toBe(onboardingStrings("en").consentTitle);
    expect(onboardingStrings("pl").aiMemoryTitle).not.toBe(onboardingStrings("en").aiMemoryTitle);
  });
});
