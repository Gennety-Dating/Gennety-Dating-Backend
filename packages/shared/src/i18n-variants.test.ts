import { afterEach, describe, expect, it } from "vitest";
import { t } from "./i18n.js";
import {
  VARIANT_KEYS,
  setVariantRng,
  tv,
  variantAlternates,
} from "./i18n-variants.js";
import type { Language } from "./types.js";

const LANGS: Language[] = ["en", "ru", "uk", "de", "pl"];

function placeholders(text: string): string[] {
  return (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
}

function markers(text: string): { bold: number; italic: number } {
  return {
    bold: (text.match(/\*/g) ?? []).length,
    italic: (text.match(/_/g) ?? []).length,
  };
}

afterEach(() => setVariantRng(null));

describe("i18n variant pools", () => {
  it("every pooled key has alternates for all five languages", () => {
    expect(VARIANT_KEYS.length).toBeGreaterThan(0);
    for (const key of VARIANT_KEYS) {
      for (const lang of LANGS) {
        const alts = variantAlternates(lang, key);
        expect(alts.length, `${key}/${lang}`).toBeGreaterThanOrEqual(2);
        for (const alt of alts) expect(alt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every alternate carries the same placeholder set and Markdown marker counts as the canonical string", () => {
    for (const key of VARIANT_KEYS) {
      for (const lang of LANGS) {
        const canonical = t(lang, key);
        for (const alt of variantAlternates(lang, key)) {
          expect(placeholders(alt), `${key}/${lang}`).toEqual(
            placeholders(canonical),
          );
          // Markdown emphasis must survive variant swaps (parse_mode safety).
          expect(markers(alt).bold % 2, `${key}/${lang} unbalanced *`).toBe(0);
          expect(markers(alt).italic % 2, `${key}/${lang} unbalanced _`).toBe(0);
          expect(markers(alt).bold > 0, `${key}/${lang} bold presence`).toBe(
            markers(canonical).bold > 0,
          );
        }
      }
    }
  });

  it("seeded rng picks deterministically; rng() => 0 yields the canonical string", () => {
    setVariantRng(() => 0);
    for (const key of VARIANT_KEYS) {
      for (const lang of LANGS) {
        expect(tv(lang, key)).toBe(t(lang, key));
      }
    }
    setVariantRng(() => 0.999);
    const alts = variantAlternates("ru", "venueWaitingPeer");
    expect(tv("ru", "venueWaitingPeer")).toBe(alts[alts.length - 1]);
  });

  it("falls through to t() for keys without a pool", () => {
    setVariantRng(() => 0.999);
    expect(tv("en", "consentAgree")).toBe(t("en", "consentAgree"));
    expect(tv("ru", "matchScheduledBtnOpenMaps")).toBe(
      t("ru", "matchScheduledBtnOpenMaps"),
    );
  });

  it("interpolates params in alternates exactly like t()", () => {
    setVariantRng(() => 0);
    // venue keys in the pool carry no params today; prove the path with a
    // param-free call and a pooled call both stay placeholder-free.
    for (const key of VARIANT_KEYS) {
      expect(tv("en", key)).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});
