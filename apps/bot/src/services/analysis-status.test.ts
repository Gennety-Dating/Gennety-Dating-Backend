import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES, t, type Language } from "@gennety/shared";
import {
  photoReviewSteps,
  photoUploadSteps,
  venueSearchSteps,
  videoCheckSteps,
} from "./analysis-status.js";
import { AI_EMOJI } from "./ai-emoji.js";
import type { StatusStep } from "./ai-stream.js";

/**
 * Both photo bursts revise a singular script into the plural one beat for beat
 * while it is on screen (`reviseStatusScript`), so the two must agree on
 * everything except wording: a length mismatch would silently drop a beat, and
 * a cadence mismatch would change the rhythm halfway through.
 */
function expectRevisableScripts(build: (lang: Language, frames: number) => StatusStep[]): void {
  for (const lang of SUPPORTED_LANGUAGES) {
    const one = build(lang, 1);
    const many = build(lang, 2);
    expect(one).toHaveLength(many.length);
    expect(one.map((step) => step.holdMs)).toEqual(many.map((step) => step.holdMs));
    expect(one.map((step) => step.emojiId)).toEqual(many.map((step) => step.emojiId));
    // At least one beat has to actually carry the count, else the split is inert.
    expect(one.map((step) => step.text)).not.toEqual(many.map((step) => step.text));
  }
}

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
    expectRevisableScripts(photoReviewSteps);
  });
});

describe("photoUploadSteps", () => {
  it("narrates a single-photo burst in the singular", () => {
    expect(photoUploadSteps("ru", 1).map((step) => step.text)).toEqual([
      t("ru", "photoUploadOneStep1"),
      t("ru", "photoUploadOneStep2"),
      t("ru", "photoUploadStep3"),
    ]);
    expect(photoUploadSteps("ru", 4).map((step) => step.text)).toEqual([
      t("ru", "photoUploadStep1"),
      t("ru", "photoUploadStep2"),
      t("ru", "photoUploadStep3"),
    ]);
  });

  it("keeps both scripts the same length and cadence in every language", () => {
    expectRevisableScripts(photoUploadSteps);
  });

  it("shares the count-neutral closing beat between both scripts", () => {
    // "Almost there…" says nothing about how many, so it is one key rather than
    // two identical ones drifting apart across five languages.
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(photoUploadSteps(lang, 1).at(-1)?.text).toBe(
        photoUploadSteps(lang, 2).at(-1)?.text,
      );
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
