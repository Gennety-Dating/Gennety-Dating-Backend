import { describe, it, expect } from "vitest";
import { t } from "./i18n.js";

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
      "llmDumpIntro", "llmPrompt", "llmDumpReceived",
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

    for (const lang of ["en", "ru", "uk"] as const) {
      for (const key of keys) {
        expect(typeof t(lang, key)).toBe("string");
      }
    }
  });

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
