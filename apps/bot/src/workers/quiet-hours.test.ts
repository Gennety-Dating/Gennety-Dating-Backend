import { describe, it, expect } from "vitest";
import { isQuietHours } from "./quiet-hours.js";

/**
 * Quiet hours are 23:00–09:00 EUROPE/KYIV — see PRODUCT_SPEC.md.
 * Pre-fix the function used `getUTCHours()`, which in summer (Kyiv = UTC+3)
 * shifts the silent window to 02:00–12:00 local — i.e. nudges fire at 06:00
 * Kyiv (deep inside the quiet window) and the bot goes silent at 12:00 (peak).
 *
 * All Date inputs below are absolute UTC instants; the assertions describe
 * what the corresponding *Kyiv* wall clock looks like and whether the function
 * should report the moment as quiet.
 */
describe("isQuietHours (Europe/Kyiv anchored)", () => {
  describe("summer (DST: Kyiv = UTC+3)", () => {
    // 2024-06-15 — DST in effect.
    it("00:00 Kyiv (21:00 UTC prev day) is quiet", () =>
      expect(isQuietHours(new Date("2024-06-14T21:00:00Z"))).toBe(true));
    it("06:00 Kyiv (03:00 UTC) is quiet", () =>
      expect(isQuietHours(new Date("2024-06-15T03:00:00Z"))).toBe(true));
    it("09:00 Kyiv (06:00 UTC) is the quiet boundary — NOT quiet", () =>
      expect(isQuietHours(new Date("2024-06-15T06:00:00Z"))).toBe(false));
    it("12:00 Kyiv (09:00 UTC) — NOT quiet (peak engagement)", () =>
      expect(isQuietHours(new Date("2024-06-15T09:00:00Z"))).toBe(false));
    it("18:00 Kyiv (15:00 UTC) — NOT quiet", () =>
      expect(isQuietHours(new Date("2024-06-15T15:00:00Z"))).toBe(false));
    it("22:59 Kyiv (19:59 UTC) — NOT quiet", () =>
      expect(isQuietHours(new Date("2024-06-15T19:59:00Z"))).toBe(false));
    it("23:00 Kyiv (20:00 UTC) — quiet", () =>
      expect(isQuietHours(new Date("2024-06-15T20:00:00Z"))).toBe(true));
  });

  describe("winter (no DST: Kyiv = UTC+2)", () => {
    // 2024-12-15 — standard time.
    it("00:00 Kyiv (22:00 UTC prev day) is quiet", () =>
      expect(isQuietHours(new Date("2024-12-14T22:00:00Z"))).toBe(true));
    it("08:59 Kyiv (06:59 UTC) — quiet", () =>
      expect(isQuietHours(new Date("2024-12-15T06:59:00Z"))).toBe(true));
    it("09:00 Kyiv (07:00 UTC) — NOT quiet", () =>
      expect(isQuietHours(new Date("2024-12-15T07:00:00Z"))).toBe(false));
    it("22:59 Kyiv (20:59 UTC) — NOT quiet", () =>
      expect(isQuietHours(new Date("2024-12-15T20:59:00Z"))).toBe(false));
    it("23:00 Kyiv (21:00 UTC) — quiet", () =>
      expect(isQuietHours(new Date("2024-12-15T21:00:00Z"))).toBe(true));
  });
});
