import { describe, expect, it } from "vitest";

import { DEMO_BEATS, demoText, type DemoBeat } from "./script.js";

/**
 * The demo's own copy, in the three languages DEMO_MODE.md says are written out.
 *
 * `BeatCopy` only makes `en` mandatory, so a beat added with an English string
 * and nothing else typechecks cleanly and then shows English to a Russian- or
 * Ukrainian-speaking visitor — in the middle of a demo, which is the one place
 * that is least recoverable. `de`/`pl` are a deliberate scope call and fall back
 * to `en`; these three do not.
 */
describe("demo script", () => {
  it("writes every beat out in ru, uk and en", () => {
    for (const beat of DEMO_BEATS) {
      const ru = demoText(beat, "ru");
      const uk = demoText(beat, "uk");
      const en = demoText(beat, "en");
      expect(ru.length, `${beat}/ru`).toBeGreaterThan(0);
      expect(uk.length, `${beat}/uk`).toBeGreaterThan(0);
      expect(en.length, `${beat}/en`).toBeGreaterThan(0);
      // Falling back to English is what a missing translation looks like.
      expect(ru, `${beat}/ru is the English copy`).not.toBe(en);
      expect(uk, `${beat}/uk is the English copy`).not.toBe(en);
    }
  });

  it("falls back to English for the two languages that are deliberately not written", () => {
    const beat: DemoBeat = "intro";
    expect(demoText(beat, "de")).toBe(demoText(beat, "en"));
    expect(demoText(beat, "pl")).toBe(demoText(beat, "en"));
    expect(demoText(beat, null)).toBe(demoText(beat, "en"));
  });

  // Both are dead ends by construction — the demo has stopped moving on its own
  // — so each must name the one thing that always works.
  it("points a stuck visitor at /restart", () => {
    for (const beat of ["retrying", "stuck"] as const) {
      for (const lang of ["ru", "uk", "en"] as const) {
        expect(demoText(beat, lang), `${beat}/${lang}`).toContain("/restart");
      }
    }
  });
});
