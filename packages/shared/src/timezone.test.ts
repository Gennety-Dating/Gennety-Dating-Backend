import { describe, it, expect } from "vitest";
import { cityKeyToTimeZone, isValidTimeZone, DEFAULT_TIME_ZONE } from "./timezone.js";

describe("cityKeyToTimeZone", () => {
  it("resolves by city-key override first (multi-tz country)", () => {
    expect(cityKeyToTimeZone("us:los-angeles", "US")).toBe("America/Los_Angeles");
    expect(cityKeyToTimeZone("us:chicago", "US")).toBe("America/Chicago");
  });

  it("falls back to the country code when no city override", () => {
    expect(cityKeyToTimeZone("ua:kyiv", "UA")).toBe("Europe/Kyiv");
    expect(cityKeyToTimeZone("pl:warsaw", "PL")).toBe("Europe/Warsaw");
    expect(cityKeyToTimeZone("de:berlin", "DE")).toBe("Europe/Berlin");
  });

  it("derives the country from the key when no explicit code", () => {
    expect(cityKeyToTimeZone("gb:london")).toBe("Europe/London");
  });

  it("defaults to Europe/Kyiv for unknown / null input", () => {
    expect(cityKeyToTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(cityKeyToTimeZone("zz:atlantis", "ZZ")).toBe(DEFAULT_TIME_ZONE);
    expect(cityKeyToTimeZone(undefined, undefined)).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Europe/Kyiv")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
