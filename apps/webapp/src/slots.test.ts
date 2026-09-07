import { describe, it, expect } from "vitest";
import { FALLBACK_TIME_ZONE, formatDate, formatSlot, formatTime, slotDayKey } from "./slots.js";

const KYIV = FALLBACK_TIME_ZONE;

describe("formatSlot", () => {
  it("returns a non-empty string for a valid date", () => {
    const result = formatSlot(new Date("2026-04-10T19:00:00Z"), "en", KYIV);
    expect(result.length).toBeGreaterThan(0);
  });

  it("renders a Russian locale label when asked", () => {
    const result = formatSlot(new Date("2026-04-10T19:00:00Z"), "ru", KYIV);
    // ru-RU month names are lowercase Cyrillic — checking that *some*
    // Cyrillic character ended up in the output is a sturdier
    // assertion than pinning the exact string (locale data drifts).
    expect(/[а-яА-Я]/.test(result)).toBe(true);
  });

  it("renders German and Polish locale labels when asked", () => {
    const date = new Date("2026-04-10T19:00:00Z");
    expect(formatSlot(date, "de", KYIV)).toMatch(/April|Apr/i);
    expect(formatSlot(date, "pl", KYIV)).toMatch(/kwi/i);
  });

  it("can format just the date for the first Mini App step", () => {
    const result = formatDate(new Date("2026-04-10T19:00:00Z"), "en", KYIV);
    expect(result.length).toBeGreaterThan(0);
  });

  it("can format just the time for the second Mini App step", () => {
    // `ru` rather than `en`: ru-RU is a 24-hour locale, so the assertion reads
    // the hour instead of whichever clock convention the runner's default
    // locale happens to use. 16:30 UTC is 19:30 in Kyiv (summer), whatever the
    // machine's own zone is.
    const result = formatTime(new Date("2026-04-10T16:30:00Z"), "ru", KYIV);
    expect(result).toMatch(/19/);
    expect(result).toMatch(/30/);
  });

  it("reads the market clock, not the device's", () => {
    // The whole point of the fix: one instant, two zones, two labels — and the
    // Mini App must show the market's, matching what the chat card says.
    const instant = new Date("2026-04-10T16:30:00Z");
    expect(formatTime(instant, "ru", "Europe/Kyiv")).toMatch(/19:30/);
    expect(formatTime(instant, "ru", "Europe/Berlin")).toMatch(/18:30/);
  });
});

describe("slotDayKey", () => {
  it("groups slots by the market's calendar day", () => {
    expect(slotDayKey(new Date("2026-04-10T16:30:00Z"), KYIV)).toBe("2026-04-10");
  });

  it("keeps a late slot on the market's day, not UTC's", () => {
    // 22:00 UTC on the 10th is 01:00 Kyiv on the 11th: grouping by the UTC day
    // (or by the device's) would file it under the wrong day button.
    expect(slotDayKey(new Date("2026-04-10T22:00:00Z"), KYIV)).toBe("2026-04-11");
  });
});
