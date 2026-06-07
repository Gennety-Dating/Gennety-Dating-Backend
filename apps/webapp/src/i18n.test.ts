import { describe, expect, it } from "vitest";
import { pickLang, tr, type Lang } from "./i18n.js";

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
});
