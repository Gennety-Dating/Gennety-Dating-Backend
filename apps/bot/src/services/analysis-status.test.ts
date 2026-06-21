import { describe, expect, it } from "vitest";
import { t } from "@gennety/shared";
import { venueSearchSteps, videoCheckSteps } from "./analysis-status.js";
import { AI_EMOJI } from "./ai-emoji.js";

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
