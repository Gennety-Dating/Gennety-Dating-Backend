import { describe, expect, it } from "vitest";

import { TERMINAL_TABLES, fill, pickLang, type Lang } from "./i18n.js";

const LANGS = Object.keys(TERMINAL_TABLES) as Lang[];
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("terminal copy", () => {
  it("has every key in every language", () => {
    const keys = Object.keys(TERMINAL_TABLES.en).sort();
    for (const lang of LANGS) {
      expect(Object.keys(TERMINAL_TABLES[lang]).sort(), lang).toEqual(keys);
    }
  });

  it("carries the same placeholders as English, so no sentence loses its number", () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(TERMINAL_TABLES[lang])) {
        const english = TERMINAL_TABLES.en[key as keyof typeof TERMINAL_TABLES.en];
        expect(placeholders(text), `${lang}.${key}`).toEqual(placeholders(english));
      }
    }
  });

  it("keeps the product names in English everywhere", () => {
    for (const lang of LANGS) {
      expect(TERMINAL_TABLES[lang].kicker).toBe("Date Terminal");
      expect(TERMINAL_TABLES[lang].titleSynced).toContain("Contact Sync");
    }
  });

  it("never addresses the user formally in ru/uk", () => {
    // «вы» is allowed only where it means the two of them, which is always the
    // plural imperative to shake together — never a capitalised «Вы»/«Ви».
    for (const lang of ["ru", "uk"] as const) {
      for (const text of Object.values(TERMINAL_TABLES[lang])) {
        expect(text).not.toMatch(/(^|[\s«])(Вы|Вас|Ваш|Ви|Вам)\b/u);
      }
    }
  });
});

describe("pickLang / fill", () => {
  it("falls back to English", () => {
    expect(pickLang("ru-RU")).toBe("ru");
    expect(pickLang("fr")).toBe("en");
    expect(pickLang(null)).toBe("en");
  });

  it("fills what it knows and leaves the rest visible", () => {
    expect(fill("{n} m from {venue}", { n: 40 })).toBe("40 m from {venue}");
  });
});
