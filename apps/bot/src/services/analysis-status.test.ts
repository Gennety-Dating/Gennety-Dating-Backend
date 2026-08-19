import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES, t, type Language } from "@gennety/shared";
import {
  photoReviewSteps,
  photoUploadSteps,
  rematchSearchSteps,
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

/**
 * The paid-Rematch search cover (PRODUCT_SPEC §3.11). Unlike every other script
 * here, its DURATION is the product requirement rather than an implementation
 * detail: the founder asked for the animation to run at least ten seconds so a
 * sub-second engine run still reads as a real search. Nothing else in the code
 * states that floor, so a well-meant "these holds feel long" edit would silently
 * delete the feature — this test is the only thing that notices.
 */
describe("rematchSearchSteps", () => {
  const total = (lang: Language): number =>
    rematchSearchSteps(lang).reduce((sum, step) => sum + step.holdMs, 0);

  it("runs for at least 10 seconds in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(total(lang)).toBeGreaterThanOrEqual(10_000);
    }
  });

  it("is identically paced across languages — only the copy is localised", () => {
    const en = rematchSearchSteps("en");
    for (const lang of SUPPORTED_LANGUAGES) {
      const steps = rematchSearchSteps(lang);
      expect(steps.map((s) => s.holdMs)).toEqual(en.map((s) => s.holdMs));
      expect(steps.map((s) => s.emojiId)).toEqual(en.map((s) => s.emojiId));
    }
  });

  it("gives every beat its own AIActions glyph, and never repeats one", () => {
    // A repeated glyph reads as the status having frozen rather than advanced —
    // the one thing a cover script must never look like.
    const ids = rematchSearchSteps("en").map((s) => s.emojiId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(AI_EMOJI.scan);
  });

  it("has non-empty, distinct copy per beat in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const texts = rematchSearchSteps(lang).map((s) => s.text);
      expect(texts.every((text) => text.trim().length > 0)).toBe(true);
      expect(new Set(texts).size).toBe(texts.length);
      // The copy must resolve — a missing key would render the key name itself.
      expect(texts).not.toContain("rematchSearchStep1");
    }
  });

  it("keeps the localised copy in step with i18n", () => {
    expect(rematchSearchSteps("ru")[0]!.text).toBe(t("ru", "rematchSearchStep1"));
  });
});
