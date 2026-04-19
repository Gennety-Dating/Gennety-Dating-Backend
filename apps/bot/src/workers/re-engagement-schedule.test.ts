import { describe, it, expect } from "vitest";
import {
  computeNextTouch,
  isKyivQuietHour,
  shiftOutOfQuietHours,
  MAX_RE_ENGAGEMENT_STEP,
} from "./re-engagement-schedule.js";

/** Build a UTC Date from a Kyiv-local wall clock (summer +03:00). */
function kyivSummer(iso: string): Date {
  return new Date(`${iso}+03:00`);
}
/** Build a UTC Date from a Kyiv-local wall clock (winter +02:00). */
function kyivWinter(iso: string): Date {
  return new Date(`${iso}+02:00`);
}

/** Format a UTC Date as HH:mm Kyiv local. */
function kyivHourMin(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Kyiv calendar day string (YYYY-MM-DD). */
function kyivDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

describe("isKyivQuietHour", () => {
  it("returns true inside the 23:00–09:00 Kyiv window", () => {
    expect(isKyivQuietHour(kyivSummer("2026-06-01T23:30:00"))).toBe(true);
    expect(isKyivQuietHour(kyivSummer("2026-06-02T03:00:00"))).toBe(true);
    expect(isKyivQuietHour(kyivSummer("2026-06-02T08:59:00"))).toBe(true);
  });

  it("returns false during daytime/evening", () => {
    expect(isKyivQuietHour(kyivSummer("2026-06-02T09:00:00"))).toBe(false);
    expect(isKyivQuietHour(kyivSummer("2026-06-02T13:00:00"))).toBe(false);
    expect(isKyivQuietHour(kyivSummer("2026-06-02T22:59:00"))).toBe(false);
  });
});

describe("shiftOutOfQuietHours", () => {
  it("leaves non-quiet moments untouched", () => {
    const t = kyivSummer("2026-06-02T15:30:00");
    expect(shiftOutOfQuietHours(t).getTime()).toBe(t.getTime());
  });

  it("defers 23:xx Kyiv to next-day 13:00 Kyiv", () => {
    const t = kyivSummer("2026-06-02T23:30:00");
    const shifted = shiftOutOfQuietHours(t);
    expect(kyivDay(shifted)).toBe("2026-06-03");
    expect(kyivHourMin(shifted)).toBe("13:00");
  });

  it("defers 03:xx Kyiv to same-day 13:00 Kyiv", () => {
    const t = kyivSummer("2026-06-03T03:15:00");
    const shifted = shiftOutOfQuietHours(t);
    expect(kyivDay(shifted)).toBe("2026-06-03");
    expect(kyivHourMin(shifted)).toBe("13:00");
  });
});

describe("computeNextTouch — normal business-hours drop-off", () => {
  // User goes silent at 10:00 Kyiv summertime.
  const lastMsg = kyivSummer("2026-06-02T10:00:00");
  const now = lastMsg;

  it("step 1 fires +15 min (10:15 Kyiv)", () => {
    const t = computeNextTouch(1, lastMsg, now)!;
    expect(kyivHourMin(t)).toBe("10:15");
    expect(kyivDay(t)).toBe("2026-06-02");
  });

  it("step 2 fires +2h (12:00 Kyiv)", () => {
    const t = computeNextTouch(2, lastMsg, now)!;
    expect(kyivHourMin(t)).toBe("12:00");
    expect(kyivDay(t)).toBe("2026-06-02");
  });

  it("step 3 fires at 19:00 Kyiv same day", () => {
    const t = computeNextTouch(3, lastMsg, now)!;
    expect(kyivHourMin(t)).toBe("19:00");
    expect(kyivDay(t)).toBe("2026-06-02");
  });

  it("step 4 fires at 19:00 Kyiv next day", () => {
    const t = computeNextTouch(4, lastMsg, now)!;
    expect(kyivHourMin(t)).toBe("19:00");
    expect(kyivDay(t)).toBe("2026-06-03");
  });

  it("step 5 fires at 14:00 Kyiv day+2", () => {
    const t = computeNextTouch(5, lastMsg, now)!;
    expect(kyivHourMin(t)).toBe("14:00");
    expect(kyivDay(t)).toBe("2026-06-04");
  });

  it("step 6 returns null (chain exhausted)", () => {
    expect(computeNextTouch(6, lastMsg, now)).toBeNull();
    expect(computeNextTouch(MAX_RE_ENGAGEMENT_STEP + 1, lastMsg, now)).toBeNull();
  });
});

describe("computeNextTouch — late-night drop-off defers to 13:00 free window", () => {
  // User drops off at 23:45 Kyiv — all short-offset touches land inside quiet hours.
  const lastMsg = kyivSummer("2026-06-02T23:45:00");
  const now = lastMsg;

  it("step 1 (+15 min → 00:00 Kyiv) is pushed to next day 13:00", () => {
    const t = computeNextTouch(1, lastMsg, now)!;
    expect(kyivDay(t)).toBe("2026-06-03");
    expect(kyivHourMin(t)).toBe("13:00");
  });

  it("step 2 (+2h → 01:45 Kyiv) is pushed to next day 13:00", () => {
    const t = computeNextTouch(2, lastMsg, now)!;
    expect(kyivDay(t)).toBe("2026-06-03");
    expect(kyivHourMin(t)).toBe("13:00");
  });
});

describe("computeNextTouch — safety guarantees", () => {
  it("is always strictly in the future relative to now", () => {
    const lastMsg = kyivSummer("2026-06-02T10:00:00");
    const nowLater = kyivSummer("2026-06-05T10:00:00"); // long past step 5
    const t = computeNextTouch(5, lastMsg, nowLater);
    // step 5 anchor was June 4 14:00, but now is June 5 10:00 → must be in future
    expect(t!.getTime()).toBeGreaterThan(nowLater.getTime());
    // And must not land in quiet hours.
    expect(isKyivQuietHour(t!)).toBe(false);
  });

  it("enforces minimum gap from lastMessageAt (step 2 never < +2h)", () => {
    const lastMsg = kyivSummer("2026-06-02T10:00:00");
    const t = computeNextTouch(2, lastMsg, lastMsg)!;
    expect(t.getTime() - lastMsg.getTime()).toBeGreaterThanOrEqual(
      2 * 60 * 60 * 1000,
    );
  });

  it("handles Kyiv winter timezone (UTC+2) correctly", () => {
    const lastMsg = kyivWinter("2026-01-15T10:00:00");
    const t = computeNextTouch(3, lastMsg, lastMsg)!;
    expect(kyivHourMin(t)).toBe("19:00");
    expect(kyivDay(t)).toBe("2026-01-15");
  });
});
