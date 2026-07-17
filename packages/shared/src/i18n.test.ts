import { describe, it, expect } from "vitest";
import { t, TRANSLATION_KEYS } from "./i18n.js";
import { SUPPORTED_LANGUAGES } from "./types.js";

/**
 * Keys that are legitimately byte-identical to English in de/pl.
 * Everything here must be either a pure template/glyph (nothing to translate)
 * or a deliberate product decision — never "we forgot".
 */
const ALLOWED_IDENTICAL_TO_EN = new Set<string>([
  // Deliberate fixed English brand line in all five locales (PRODUCT_SPEC §3.7a).
  "dateCardSlogan",
  // Pure glyphs / placeholder templates — no prose to translate.
  "btnLike",
  "btnDislike",
  "myProfileBody",
  "photoManagerDeleteBtn",
  "matchPhotoCaption",
  "coordProxyRelayNamedPrefix",
]);

describe("t (translation)", () => {
  it("returns English string by default", () => {
    const result = t("en", "welcome");
    expect(result).toContain("Gennety Dating");
  });

  it("returns Russian string", () => {
    const result = t("ru", "welcome");
    expect(result).toContain("Gennety Dating");
  });

  it("returns Ukrainian string", () => {
    const result = t("uk", "welcome");
    expect(result).toContain("Gennety Dating");
  });

  it("returns German and Polish strings", () => {
    expect(t("de", "chooseLanguage")).toContain("Sprache");
    expect(t("pl", "chooseLanguage")).toContain("język");
  });

  it("interpolates parameters", () => {
    const result = t("en", "otpSent", { email: "test@stanford.edu" });
    expect(result).toContain("test@stanford.edu");
  });

  it("interpolates numeric parameters", () => {
    const result = t("en", "invalidAge", { min: 17, max: 35 });
    expect(result).toContain("17");
    expect(result).toContain("35");
  });

  it("returns all keys for all languages without throwing", () => {
    const keys: Array<Parameters<typeof t>[1]> = [
      "welcome", "chooseLanguage", "philosophyPitch", "philosophyContinue",
      "askEmail", "invalidEmail", "otpSent", "otpInvalid", "otpExpired",
      "emailVerified", "askFirstName", "askSurname", "askAge", "invalidAge",
      "llmDumpReceived",
      "askPhotos", "photoReceived", "photosEnough", "photosDone",
      "profileReview", "profileConfirm", "profileEdit", "onboardingComplete",
      "btnLike", "btnDislike", "btnContinuePhotos",
      // Phase 2 — Main Menu
      "menuTitle", "menuMyProfile", "menuEdit", "menuPause", "menuResume",
      "menuSettings", "menuHelp", "menuBack",
      "myProfileBody", "myProfileNoBio",
      "editProfileBody", "editProfilePhotosBtn", "editProfilePhotosStart",
      "editProfilePhotosSaved",
      "pauseConfirmed", "resumeConfirmed",
      "settingsTitle", "settingsLanguage", "settingsLanguagePick", "settingsLanguageSaved",
      "helpBody",
    ];

    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of keys) {
        expect(typeof t(lang, key)).toBe("string");
      }
    }
  });

  it("localizes core preregistration and onboarding keys for every supported language", () => {
    const keys = [
      "consentMessage",
      "consentAgree",
      "askEmail",
      "otpSent",
      "emailVerified",
      "chooseLanguage",
      "settingsLanguagePick",
      "verifyPitch",
      "verifyPitchMandatory",
      "verifySkipNudgeCaption",
      "verifyBtnSkipConfirm",
      "feedbackThanks",
    ] as const;

    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of keys) {
        const value = t(lang, key, { email: "test@stanford.edu" });
        expect(value.length).toBeGreaterThan(0);
        if (lang === "de" || lang === "pl") {
          expect(value).not.toBe(t("en", key, { email: "test@stanford.edu" }));
        }
      }
    }
  });

  // `deTranslations`/`plTranslations` are built as `{ ...translations.en, ...overrides }`,
  // so a key nobody overrode silently renders ENGLISH to the user rather than
  // failing. That shipped the whole pre-date coordination flow + the ticket DMs
  // in English to de/pl users. Nothing but this test catches the next one.
  it.each(["de", "pl"] as const)(
    "%s never falls through to the English string (spread-inheritance guard)",
    (lang) => {
      const leaked = TRANSLATION_KEYS.filter(
        (key) =>
          !ALLOWED_IDENTICAL_TO_EN.has(key) && t(lang, key) === t("en", key),
      );
      expect(
        leaked,
        `${leaked.length} ${lang} key(s) are byte-identical to English — either translate them, ` +
          `or add them to ALLOWED_IDENTICAL_TO_EN with a reason if there is genuinely nothing to translate.`,
      ).toEqual([]);
    },
  );

  it("menu keys contain expected action labels in English", () => {
    expect(t("en", "menuMyProfile")).toContain("My Profile");
    expect(t("en", "menuPause")).toContain("Pause");
    expect(t("en", "menuResume")).toContain("Resume");
    expect(t("en", "menuSettings")).toContain("Settings");
  });

  it("editProfileBody interpolates all four fixed fields", () => {
    const body = t("en", "editProfileBody", {
      firstName: "Alice",
      surname: "Smith",
      age: 21,
      university: "stanford.edu",
    });
    expect(body).toContain("Alice");
    expect(body).toContain("Smith");
    expect(body).toContain("21");
    expect(body).toContain("stanford.edu");
    expect(body.toLowerCase()).toContain("locked in");
  });
});
