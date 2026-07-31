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
