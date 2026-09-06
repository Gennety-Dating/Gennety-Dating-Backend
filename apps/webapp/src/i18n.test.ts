import { describe, expect, it } from "vitest";
import { monthsPhrase, pickLang, tr, type Lang } from "./i18n.js";

const languages: Lang[] = ["en", "ru", "uk", "de", "pl"];

describe("Mini App i18n", () => {
  it("accepts every supported language from query params", () => {
    for (const lang of languages) {
      expect(pickLang(lang)).toBe(lang);
    }
  });

  it("falls back to English for unknown languages", () => {
    expect(pickLang("fr")).toBe("en");
    expect(pickLang(null)).toBe("en");
  });

  it("has translated core labels for the new languages", () => {
    expect(tr("de", "title")).toContain("Zeit");
    expect(tr("pl", "title")).toContain("termin");
    expect(tr("de", "locTitle")).toContain("Date");
    expect(tr("pl", "locTitle")).toContain("randkę");
  });

  it("has location quick-action strings for every supported language", () => {
    for (const lang of languages) {
      expect(tr(lang, "locShareCurrent").length).toBeGreaterThan(0);
      expect(tr(lang, "locSharingCurrent").length).toBeGreaterThan(0);
      expect(tr(lang, "locCurrentLocation").length).toBeGreaterThan(0);
      expect(tr(lang, "locErrGeoDenied").length).toBeGreaterThan(0);
      expect(tr(lang, "locErrGeoUnavailable").length).toBeGreaterThan(0);
      expect(tr(lang, "locErrGeoTimeout").length).toBeGreaterThan(0);
      expect(tr(lang, "locErrGeoUnsupported").length).toBeGreaterThan(0);
      expect(tr(lang, "locErrMapUnavailable").length).toBeGreaterThan(0);
    }
  });

  it("has Prime Time copy, with the Stars placeholder intact, in every language", () => {
    for (const lang of languages) {
      // The charge is interpolated at the call site, so a locale that lost the
      // placeholder renders "Open the evening — ⭐" and asks for an unnamed
      // amount of money. That is the one failure this block cannot tolerate.
      expect(tr(lang, "primeSheetCtaPay")).toContain("{stars}");
      // ...and it must be the ONLY number in the sentence. A USD figure baked
      // into a translation is a second price the server can never move, and
      // §5 is explicit that this rail quotes Stars and nothing else.
      expect(tr(lang, "primeSheetCtaPay").replace("{stars}", "")).not.toMatch(/\d/);
      expect(tr(lang, "primeSheetBody").length).toBeGreaterThan(0);
      expect(tr(lang, "primeSheetTitle").length).toBeGreaterThan(0);
      expect(tr(lang, "primeUnlockFailed").length).toBeGreaterThan(0);
      // The band's own caption quotes the same charge and carries the same
      // rule — it is the affordance most users actually tap, since it sits in
      // the list rather than behind it.
      expect(tr(lang, "primeBandCta")).toContain("{stars}");
      expect(tr(lang, "primeBandCta").replace("{stars}", "")).not.toMatch(/\d/);
      // The star is an authored glyph appended at the call site, never the
      // platform character: that one renders as Apple's art on iOS, Google's on
      // Android and a font glyph on the web — three different products quoting
      // one price. A locale that pastes it back in undoes the icon set.
      for (const key of ["primeSheetCtaPay", "primeBandCta"] as const) {
        expect(tr(lang, key)).not.toContain("\u2b50");
      }
      // Neither header may name how many rows are gated: that count is
      // `PRIME_TIME_SLOT_COUNT`, an env value the server moves without anyone
      // re-translating five locales.
      for (const key of ["primeBandLocked", "primeBandOpen", "primeBandOpenTag"] as const) {
        expect(tr(lang, key).length).toBeGreaterThan(0);
        expect(tr(lang, key)).not.toMatch(/\d/);
      }
    }
  });

  it("has departure-point gate copy, with the city placeholder intact, in every language", () => {
    // The city name is interpolated at the call site (`tr` has no params), so a
    // locale that lost the placeholder would render a sentence naming no city
    // at all — the one fact the block card exists to deliver.
    for (const lang of languages) {
      expect(tr(lang, "locOutsideMarket")).toContain("{city}");
      expect(tr(lang, "locJumpToCity")).toContain("{city}");
    }
  });

  it("monthsPhrase declines the unit word for every supported language", () => {
    expect(monthsPhrase("en", 1)).toBe("1 month");
    expect(monthsPhrase("en", 3)).toBe("3 months");
    expect(monthsPhrase("de", 1)).toBe("1 Monat");
    expect(monthsPhrase("de", 3)).toBe("3 Monate");
    expect(monthsPhrase("ru", 1)).toBe("1 месяц");
    expect(monthsPhrase("ru", 2)).toBe("2 месяца");
    expect(monthsPhrase("ru", 5)).toBe("5 месяцев");
    expect(monthsPhrase("ru", 11)).toBe("11 месяцев");
    expect(monthsPhrase("uk", 1)).toBe("1 місяць");
    expect(monthsPhrase("uk", 3)).toBe("3 місяці");
    expect(monthsPhrase("uk", 11)).toBe("11 місяців");
    expect(monthsPhrase("pl", 1)).toBe("1 miesiąc");
    expect(monthsPhrase("pl", 2)).toBe("2 miesiące");
    expect(monthsPhrase("pl", 12)).toBe("12 miesięcy");
  });
});
