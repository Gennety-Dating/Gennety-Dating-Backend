import { describe, it, expect } from "vitest";
import { isQuietHours } from "./quiet-hours.js";

describe("isQuietHours", () => {
  const h = (utcHour: number) => new Date(`2024-06-15T${String(utcHour).padStart(2, "0")}:00:00Z`);

  it("returns true for midnight (00:00 UTC)", () => expect(isQuietHours(h(0))).toBe(true));
  it("returns true for 02:00 UTC", ()             => expect(isQuietHours(h(2))).toBe(true));
  it("returns true for 08:59 UTC",  ()            => {
    const d = new Date("2024-06-15T08:59:00Z");
    expect(isQuietHours(d)).toBe(true);
  });
  it("returns false for 09:00 UTC", ()            => expect(isQuietHours(h(9))).toBe(false));
  it("returns false for 12:00 UTC", ()            => expect(isQuietHours(h(12))).toBe(false));
  it("returns false for 22:59 UTC", ()            => {
    const d = new Date("2024-06-15T22:59:00Z");
    expect(isQuietHours(d)).toBe(false);
  });
  it("returns true for 23:00 UTC", ()             => expect(isQuietHours(h(23))).toBe(true));
});
