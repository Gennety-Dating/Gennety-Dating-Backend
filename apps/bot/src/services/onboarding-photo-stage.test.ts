import { describe, expect, it } from "vitest";
import {
  isPhotoStageContinueText,
  onboardingPhotoStageText,
} from "./onboarding-photo-stage.js";

describe("onboardingPhotoStageText", () => {
  it("asks only for the missing minimum before the minimum photos", () => {
    expect(
      onboardingPhotoStageText({
        language: "en",
        photoCount: 1,
        ticketFeatureEnabled: true,
        hasVideo: false,
      }),
    ).toContain("1/4");
  });

  it("offers both ticket paths after the minimum", () => {
    const text = onboardingPhotoStageText({
      language: "en",
      photoCount: 4,
      ticketFeatureEnabled: true,
      hasVideo: false,
    });

    expect(text).toContain("6 photos");
    expect(text).toContain("profile video");
    expect(text).toContain("optional");
  });

  it("does not re-offer the video ticket after a video was added", () => {
    const text = onboardingPhotoStageText({
      language: "en",
      photoCount: 5,
      ticketFeatureEnabled: true,
      hasVideo: true,
    });

    expect(text).toContain("second free Date Ticket");
    expect(text).not.toContain("profile video");
  });

  it("keeps the video path open after six photos", () => {
    const text = onboardingPhotoStageText({
      language: "ru",
      photoCount: 6,
      ticketFeatureEnabled: true,
      hasVideo: false,
    });

    expect(text).toContain("короткое видео");
    expect(text).toContain("продолжай");
    expect(text).toContain("до 10");
  });

  it("uses a non-monetized optional-media message when tickets are disabled", () => {
    const text = onboardingPhotoStageText({
      language: "en",
      photoCount: 4,
      ticketFeatureEnabled: false,
      hasVideo: false,
    });

    expect(text).toContain("short profile video");
    expect(text).not.toContain("Date Ticket");
  });

  it("does not offer another video when tickets are disabled and one exists", () => {
    const text = onboardingPhotoStageText({
      language: "en",
      photoCount: 4,
      ticketFeatureEnabled: false,
      hasVideo: true,
    });

    expect(text).not.toContain("send one short profile video");
    expect(text.toLowerCase()).toContain("continue");
  });

  it("only offers Continue when all media slots and bonuses are complete", () => {
    const text = onboardingPhotoStageText({
      language: "en",
      photoCount: 10,
      ticketFeatureEnabled: true,
      hasVideo: true,
    });

    expect(text).toContain("both free Date Tickets");
    expect(text.toLowerCase()).toContain("continue");
    expect(text).not.toContain("add photos");
    expect(text).not.toContain("send one short profile video");
  });
});

describe("isPhotoStageContinueText", () => {
  it.each(["continue", "done", "дальше", "готово", "далі", "weiter", "dalej"])(
    "recognizes %s",
    (text) => {
      expect(isPhotoStageContinueText(text)).toBe(true);
    },
  );

  it("does not treat a question as completion", () => {
    expect(isPhotoStageContinueText("Что это за билет?")).toBe(false);
  });
});
