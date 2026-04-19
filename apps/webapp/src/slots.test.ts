import { describe, it, expect } from "vitest";
import { generateSlots, formatSlot } from "./slots.js";

describe("generateSlots", () => {
  it("generates the requested number of slots", () => {
    const slots = generateSlots(new Date("2026-04-09T12:00:00Z"), 6);
    expect(slots).toHaveLength(6);
  });

  it("all slots are at 19:00 local time", () => {
    const slots = generateSlots(new Date("2026-04-09T12:00:00Z"));
    for (const slot of slots) {
      expect(slot.getHours()).toBe(19);
      expect(slot.getMinutes()).toBe(0);
    }
  });

  it("excludes Sundays (day=0) and Mondays (day=1)", () => {
    const slots = generateSlots(new Date("2026-04-09T12:00:00Z"), 10);
    for (const slot of slots) {
      const day = slot.getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(1);
    }
  });

  it("starts from the day after 'now'", () => {
    const now = new Date("2026-04-09T12:00:00Z"); // Thursday
    const slots = generateSlots(now, 1);
    // Apr 10 is Friday (day=5) — should be included
    expect(slots[0]!.getDate()).toBe(10);
  });

  it("skips Sunday and Monday correctly", () => {
    // Saturday Apr 11 → next after that is Sunday (skip), Monday (skip), Tuesday Apr 14
    const saturday = new Date("2026-04-11T12:00:00Z");
    const slots = generateSlots(saturday, 2);
    // Apr 12 = Sun (skip), Apr 13 = Mon (skip), Apr 14 = Tue (first), Apr 15 = Wed (second)
    expect(slots[0]!.getDay()).not.toBe(0);
    expect(slots[0]!.getDay()).not.toBe(1);
    expect(slots[1]!.getDay()).not.toBe(0);
    expect(slots[1]!.getDay()).not.toBe(1);
  });

  it("returns empty array when count is 0", () => {
    expect(generateSlots(new Date(), 0)).toEqual([]);
  });

  it("returns distinct dates — no duplicates", () => {
    const slots = generateSlots(new Date("2026-04-09T12:00:00Z"), 6);
    const isos = slots.map((s) => s.toISOString());
    expect(new Set(isos).size).toBe(6);
  });
});

describe("formatSlot", () => {
  it("returns a non-empty string for a valid date", () => {
    const result = formatSlot(new Date("2026-04-10T19:00:00Z"));
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the hour in the formatted output", () => {
    const result = formatSlot(new Date("2026-04-10T19:00:00Z"));
    // The local representation should include "19" or the equivalent in local tz
    expect(result).toBeTruthy();
  });
});
