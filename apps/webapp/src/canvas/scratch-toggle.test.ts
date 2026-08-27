/**
 * The Scratch Map's consent has to be REACHABLE.
 *
 * Regression: for a while `putScratchOptIn` had no caller anywhere in
 * `apps/webapp` — not in source, not in tests — while `canvas.ts` returned
 * early on `if (!scratch?.optIn)` and `User.scratchMapOptIn` defaults to
 * false. The endpoint, the client call, the fog layer, the percentage readout
 * and five locales of copy were all built and could not be switched on by any
 * user on any surface. Nothing failed; the feature was simply unreachable.
 *
 * A wiring guard rather than a behavioural one, for the reason
 * `location-thinking.test.ts` and `keyboard-ease.test.ts` already state: this
 * lives in a module that runs DOM effects on import, so the honest check is
 * the source text plus the markup it depends on.
 */
import { describe, expect, it } from "vitest";

import CANVAS_TS from "../canvas.ts?raw";
import CANVAS_HTML from "../../canvas.html?raw";
import { stringsFor } from "./i18n.js";
import type { Lang } from "./i18n.js";

const LANGS: Lang[] = ["en", "ru", "uk", "de", "pl"];

describe("the Scratch Map consent is reachable", () => {
  it("calls putScratchOptIn from somewhere", () => {
    // Not just imported — actually invoked. An unused import type-checks and
    // ships, which is exactly how this went unnoticed.
    expect(CANVAS_TS).toMatch(/putScratchOptIn\(/);
  });

  it("has a control in the markup, and the code reads it", () => {
    expect(CANVAS_HTML).toContain('id="scratch-toggle"');
    expect(CANVAS_TS).toContain('getElementById("scratch-toggle")');
    expect(CANVAS_TS).toMatch(/scratchToggle\?\.addEventListener\("click"/);
  });

  it("offers the consent only where the collection it authorises happens", () => {
    // `pingScratch` runs in IDLE_EXPLORING and nowhere else, so the control
    // must not appear on a screen that is about a date.
    expect(CANVAS_TS).toMatch(/latest\?\.state === "IDLE_EXPLORING" && scratch !== null/);
  });
});

describe("the consent copy", () => {
  it("exists in every language", () => {
    for (const lang of LANGS) {
      const s = stringsFor(lang);
      expect(s.scratchOffer.length, lang).toBeGreaterThan(0);
      expect(s.scratchEnable.length, lang).toBeGreaterThan(0);
      expect(s.scratchDisable.length, lang).toBeGreaterThan(0);
      expect(s.scratchFailed.length, lang).toBeGreaterThan(0);
    }
  });

  it("says what is stored and when, not just what it does", () => {
    // The four things §Scratch Map requires this control to carry. Checked as
    // length rather than by phrase — a consent that shrinks to "Turn on the
    // map?" is the failure worth catching, and only this string can carry it.
    for (const lang of LANGS) {
      expect(stringsFor(lang).scratchOffer.length, lang).toBeGreaterThan(120);
    }
  });

  it("never promises the exact location is kept", () => {
    // The whole privacy claim is that a tile is a neighbourhood, so the copy
    // must not be edited into saying something the storage does not do.
    for (const lang of LANGS) {
      const offer = stringsFor(lang).scratchOffer.toLowerCase();
      expect(offer, lang).not.toMatch(/gps|coordinate|координат|współrzędn/);
    }
  });
});
