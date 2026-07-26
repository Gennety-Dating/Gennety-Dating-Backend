import { describe, expect, it } from "vitest";
import { LIVENESS_TEXT, livenessText, type LivenessText } from "./liveness-i18n.js";

/**
 * The detector's on-screen line IS the instruction — "move closer", "hold
 * still", "centre your face". Amplify's `LivenessDisplayText` is all-optional
 * and silently falls back to English, so a half-finished translation does not
 * fail loudly; it strands a user mid-capture with a sentence they can't read
 * while a camera is pointed at their face.
 *
 * These tests exist to make that failure impossible to ship.
 */

const LANGS = ["en", "ru", "uk", "de", "pl"] as const;

/**
 * Pinned so a future `@aws-amplify/ui-react-liveness` upgrade that adds a
 * string cannot slip through untranslated. The package does not re-export its
 * defaults from the root, so this count is the drift alarm: if the detector
 * starts showing English again after a bump, this is the test that says why.
 * Bumping it is a deliberate act — add the new key to all five languages first.
 */
const EXPECTED_KEY_COUNT = 52;

describe("liveness detector copy", () => {
  it("covers every language the product ships", () => {
    expect(Object.keys(LIVENESS_TEXT).sort()).toEqual([...LANGS].sort());
  });

  it("has every key in every language — no silent English fallback", () => {
    const reference = Object.keys(LIVENESS_TEXT.en).sort();
    expect(reference).toHaveLength(EXPECTED_KEY_COUNT);

    for (const lang of LANGS) {
      expect(Object.keys(LIVENESS_TEXT[lang]).sort(), `${lang} key set`).toEqual(
        reference,
      );
    }
  });

  it("has no empty strings", () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(LIVENESS_TEXT[lang])) {
        expect(value.trim(), `${lang}.${key}`).not.toBe("");
      }
    }
  });

  it("actually translates the mid-capture hints away from English", () => {
    // The `hint*` strings are the ones a user reads while the camera is on. A
    // non-English locale sharing English wording here means the translation
    // was skipped, not that the languages happen to agree.
    const hintKeys = (Object.keys(LIVENESS_TEXT.en) as Array<keyof LivenessText>)
      .filter((k) => k.startsWith("hint"));
    expect(hintKeys.length).toBeGreaterThan(10);

    for (const lang of ["ru", "uk", "de", "pl"] as const) {
      for (const key of hintKeys) {
        expect(LIVENESS_TEXT[lang][key], `${lang}.${key}`).not.toBe(
          LIVENESS_TEXT.en[key],
        );
      }
    }
  });

  it("keeps the mid-capture hints short enough to read at arm's length", () => {
    // These are read in a glance while holding a phone up, mid-check. Long
    // sentences here are unreadable in practice. The two screen-reader strings
    // are deliberately exempt — they are never shown visually.
    const screenReaderOnly = new Set(["hintCenterFaceInstructionText"]);
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(LIVENESS_TEXT[lang])) {
        if (!key.startsWith("hint") || screenReaderOnly.has(key)) continue;
        expect(value.length, `${lang}.${key} = "${value}"`).toBeLessThanOrEqual(60);
      }
    }
  });

  it("falls back to English for a language we do not ship", () => {
    expect(livenessText("xx" as never)).toBe(LIVENESS_TEXT.en);
  });
});
