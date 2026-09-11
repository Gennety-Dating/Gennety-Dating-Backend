import { describe, expect, it } from "vitest";

import {
  DATE_BUMP_OPENS_MINUTES,
  DATE_RADAR_LEAD_MINUTES,
  DATE_TERMINAL_INVITE_LEAD_MINUTES,
  DATE_TERMINAL_REMINDER_GRACE_MINUTES,
  DATE_TERMINAL_REMINDER_LEAD_MINUTES,
  checkBumpWindow,
  dateTerminalBeatFor,
} from "./date-lifecycle.js";

const AGREED = new Date("2026-09-11T16:00:00.000Z");
const MIN = 60_000;

/** `now` at an offset from the date itself, in minutes. */
const at = (minutes: number): Date => new Date(AGREED.getTime() + minutes * MIN);
const NOTHING_SENT = { invite: false, reminder: false };

describe("dateTerminalBeatFor", () => {
  it("is silent before the invite window opens", () => {
    expect(dateTerminalBeatFor(AGREED, at(-5 * 60), NOTHING_SENT)).toBeNull();
    expect(dateTerminalBeatFor(AGREED, at(-46), NOTHING_SENT)).toBeNull();
  });

  it("owes the invite from T-45m up to (not including) T-15m", () => {
    expect(dateTerminalBeatFor(AGREED, at(-45), NOTHING_SENT)).toBe("invite");
    expect(dateTerminalBeatFor(AGREED, at(-30), NOTHING_SENT)).toBe("invite");
    expect(dateTerminalBeatFor(AGREED, at(-15.01), NOTHING_SENT)).toBe("invite");
  });

  it("owes the reminder from T-15m until the grace runs out", () => {
    expect(dateTerminalBeatFor(AGREED, at(-15), NOTHING_SENT)).toBe("reminder");
    expect(dateTerminalBeatFor(AGREED, at(0), NOTHING_SENT)).toBe("reminder");
    expect(dateTerminalBeatFor(AGREED, at(DATE_TERMINAL_REMINDER_GRACE_MINUTES - 1), NOTHING_SENT)).toBe(
      "reminder",
    );
    expect(dateTerminalBeatFor(AGREED, at(DATE_TERMINAL_REMINDER_GRACE_MINUTES), NOTHING_SENT)).toBeNull();
  });

  it("never sends a late invite after the reminder window has opened", () => {
    // A process that slept through the invite and wakes at T-10m sends ONE
    // message, not two back to back: the windows are disjoint on purpose.
    expect(dateTerminalBeatFor(AGREED, at(-10), NOTHING_SENT)).toBe("reminder");
  });

  it("does not repeat a message that was already claimed", () => {
    expect(dateTerminalBeatFor(AGREED, at(-40), { invite: true, reminder: false })).toBeNull();
    expect(dateTerminalBeatFor(AGREED, at(-5), { invite: true, reminder: true })).toBeNull();
    // The reminder does not care whether the invite ever went out.
    expect(dateTerminalBeatFor(AGREED, at(-5), { invite: false, reminder: false })).toBe("reminder");
    expect(dateTerminalBeatFor(AGREED, at(-5), { invite: true, reminder: false })).toBe("reminder");
  });

  it("opens the terminal when the radar starts and reminds when the sync opens", () => {
    // The two leads are tied to the windows they announce; if either constant
    // moves, the message has to move with it.
    expect(DATE_TERMINAL_INVITE_LEAD_MINUTES).toBe(DATE_RADAR_LEAD_MINUTES);
    expect(DATE_TERMINAL_REMINDER_LEAD_MINUTES).toBe(DATE_BUMP_OPENS_MINUTES);
    // …and the reminder never lands at a moment the server would refuse a shake.
    const firstReminder = at(-DATE_TERMINAL_REMINDER_LEAD_MINUTES);
    expect(checkBumpWindow(AGREED, firstReminder)).toBe("ok");
    expect(checkBumpWindow(AGREED, at(-DATE_TERMINAL_REMINDER_LEAD_MINUTES - 0.01))).toBe("too-early");
  });
});
