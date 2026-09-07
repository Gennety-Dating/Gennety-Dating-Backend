import { describe, it, expect } from "vitest";
import { isQuietHourIn, localHourIn, QUIET_START_HOUR, QUIET_END_HOUR } from "./quiet-hours.js";

/**
 * Одна реализация вместо трёх.
 *
 * Их было три: две в киевской зоне и одна в зоне пользователя, с одинаковыми
 * числами и разной системой координат. Пока рынок один, разницы не видно —
 * второй расщепил бы поведение молча.
 */
describe("isQuietHourIn", () => {
  it("окно проходит через полночь", () => {
    // 23:30 Киева зимой — это 21:30 UTC.
    expect(isQuietHourIn(new Date("2026-01-15T21:30:00Z"), "Europe/Kyiv")).toBe(true);
    // 03:00 Киева.
    expect(isQuietHourIn(new Date("2026-01-15T01:00:00Z"), "Europe/Kyiv")).toBe(true);
    // 10:00 Киева — уже день.
    expect(isQuietHourIn(new Date("2026-01-15T08:00:00Z"), "Europe/Kyiv")).toBe(false);
  });

  it("границы: 23:00 внутри, 09:00 снаружи", () => {
    expect(isQuietHourIn(new Date("2026-01-15T21:00:00Z"), "Europe/Kyiv")).toBe(true);
    expect(isQuietHourIn(new Date("2026-01-15T07:00:00Z"), "Europe/Kyiv")).toBe(false);
  });

  it("учитывает переход на летнее время", () => {
    // `getUTCHours()` здесь однажды уже стоил дорого: летом Киев это UTC+3, и
    // окно уезжало на 02:00–12:00 — бот молчал в пик и слал напоминания в шесть
    // утра. Один и тот же UTC-момент летом и зимой попадает в разные стороны.
    const summerNoonKyiv = new Date("2026-07-15T09:00:00Z"); // 12:00 Киева
    expect(isQuietHourIn(summerNoonKyiv, "Europe/Kyiv")).toBe(false);
    const summerNightKyiv = new Date("2026-07-15T21:00:00Z"); // 00:00 Киева
    expect(isQuietHourIn(summerNightKyiv, "Europe/Kyiv")).toBe(true);
  });

  it("зона — параметр, а не константа", () => {
    // Один момент, две зоны, разные ответы. Ради этого разделения всё и делалось.
    const moment = new Date("2026-01-15T21:30:00Z"); // 23:30 Киева, 16:30 Нью-Йорка
    expect(isQuietHourIn(moment, "Europe/Kyiv")).toBe(true);
    expect(isQuietHourIn(moment, "America/New_York")).toBe(false);
  });

  it("границы окна — общие константы", () => {
    expect(QUIET_START_HOUR).toBe(23);
    expect(QUIET_END_HOUR).toBe(9);
  });
});

describe("localHourIn", () => {
  it("отдаёт местный час в диапазоне 0..23", () => {
    // Полночь: некоторые среды Intl отдают «24».
    expect(localHourIn(new Date("2026-01-15T22:00:00Z"), "Europe/Kyiv")).toBe(0);
  });
});
