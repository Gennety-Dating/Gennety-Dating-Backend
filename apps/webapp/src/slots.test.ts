import { describe, it, expect } from "vitest";
import { formatDate, formatSlot, formatTime, slotDayKey } from "./slots.js";

describe("formatSlot", () => {
  it("returns a non-empty string for a valid date", () => {
    const result = formatSlot(new Date("2026-04-10T19:00:00Z"), "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("renders a Russian locale label when asked", () => {
    const result = formatSlot(new Date("2026-04-10T19:00:00Z"), "ru");
    // ru-RU month names are lowercase Cyrillic — checking that *some*
    // Cyrillic character ended up in the output is a sturdier
    // assertion than pinning the exact string (locale data drifts).
    expect(/[а-яА-Я]/.test(result)).toBe(true);
  });

  it("renders German and Polish locale labels when asked", () => {
    const date = new Date("2026-04-10T19:00:00Z");
    expect(formatSlot(date, "de")).toMatch(/April|Apr/i);
    expect(formatSlot(date, "pl")).toMatch(/kwi/i);
  });

  it("can format just the date for the first Mini App step", () => {
    const result = formatDate(new Date("2026-04-10T19:00:00Z"), "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("can format just the time for the second Mini App step", () => {
    const result = formatTime(new Date(2026, 3, 10, 17, 30), "en");
    expect(result).toMatch(/17|5/);
    expect(result).toMatch(/30/);
  });

  it("groups slots by local calendar day", () => {
    expect(slotDayKey(new Date(2026, 3, 10, 17, 30))).toBe("2026-04-10");
  });
});
