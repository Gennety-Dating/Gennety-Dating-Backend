import { describe, expect, it } from "vitest";
import { t } from "@gennety/shared";
import { photoReviewSteps, venueSearchSteps, videoCheckSteps } from "./analysis-status.js";
import { AI_EMOJI } from "./ai-emoji.js";
import { SUPPORTED_LANGUAGES } from "@gennety/shared";

describe("venueSearchSteps", () => {
  it("uses the concierge venue-search timing cadence", () => {
    const steps = venueSearchSteps("ru");

    expect(steps.map((step) => step.holdMs)).toEqual([3200, 2000, 2500, 0]);
    expect(steps.map((step) => step.text)).toEqual([
      t("ru", "venueSearching"),
      t("ru", "venueSearching"),
      t("ru", "venueSearchStep2"),
      t("ru", "venueSearchStep3"),
    ]);
  });
});

describe("photoReviewSteps", () => {
  it("narrates a single-photo burst in the singular", () => {
    expect(photoReviewSteps("ru", 1).map((step) => step.text)).toEqual([
      t("ru", "photoReviewOneStep1"),
      t("ru", "photoReviewOneStep2"),
    ]);
    expect(photoReviewSteps("ru", 3).map((step) => step.text)).toEqual([
      t("ru", "photoReviewStep1"),
      t("ru", "photoReviewStep2"),
    ]);
  });

  it("keeps both scripts the same length and cadence in every language", () => {
    // `handlePhotoFrame` revises a singular script into the plural one beat for
    // beat when the burst grows, so a mismatch would silently drop a beat.
    for (const lang of SUPPORTED_LANGUAGES) {
      const one = photoReviewSteps(lang, 1);
      const many = photoReviewSteps(lang, 2);
      expect(one).toHaveLength(many.length);
      expect(one.map((step) => step.holdMs)).toEqual(many.map((step) => step.holdMs));
      expect(one.map((step) => step.emojiId)).toEqual(many.map((step) => step.emojiId));
      expect(one.map((step) => step.text)).not.toEqual(many.map((step) => step.text));
    }
  });
});

describe("videoCheckSteps", () => {
  it("opens on the film glyph then reuses the spark for the identity + safety beats", () => {
    const steps = videoCheckSteps("ru");

    expect(steps.map((step) => step.holdMs)).toEqual([2800, 3600, 2500]);
    expect(steps.map((step) => step.emojiId)).toEqual([
      AI_EMOJI.video,
      AI_EMOJI.spark,
      AI_EMOJI.spark,
    ]);
    expect(steps.map((step) => step.text)).toEqual([
      t("ru", "videoCheckStep1"),
      t("ru", "videoCheckStep2"),
      t("ru", "videoCheckStep3"),
    ]);
  });
});
