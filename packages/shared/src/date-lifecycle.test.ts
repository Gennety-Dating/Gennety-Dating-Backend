import { describe, expect, it } from "vitest";

import {
  DATE_DAY_BEAT_WINDOW_MINUTES,
  DATE_DAY_END_GRACE_MINUTES,
  DATE_DAY_END_HOURS,
  DATE_DAY_SPOTTER_LEAD_MINUTES,
  DATE_DAY_VIBE_AFTER_HOURS,
  dateDayBeatFor,
} from "./date-lifecycle.js";

const AGREED = new Date("2026-09-01T18:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** `now` at an offset from the date itself, in minutes. */
const at = (minutes: number): Date => new Date(AGREED.getTime() + minutes * MIN);

describe("dateDayBeatFor", () => {
  it("is silent for a date that is still hours away", () => {
    expect(dateDayBeatFor(AGREED, at(-5 * 60))).toBeNull();
    expect(dateDayBeatFor(AGREED, at(-60))).toBeNull();
  });

  it("fires the spotter beat exactly at T-30m and through its window", () => {
    expect(dateDayBeatFor(AGREED, at(-DATE_DAY_SPOTTER_LEAD_MINUTES))).toBe("spotter");
    expect(
      dateDayBeatFor(AGREED, at(-DATE_DAY_SPOTTER_LEAD_MINUTES + DATE_DAY_BEAT_WINDOW_MINUTES - 1)),
    ).toBe("spotter");
  });

  it("closes the spotter window rather than re-firing for the rest of the evening", () => {
    // The bug this pins: a boundary check written as "now >= T-30m" instead of
    // "now just crossed T-30m" fires on every tick from here to the end of the
    // date — that is thirty pushes an hour, all of them identical.
    expect(
      dateDayBeatFor(AGREED, at(-DATE_DAY_SPOTTER_LEAD_MINUTES + DATE_DAY_BEAT_WINDOW_MINUTES)),
    ).toBeNull();
    expect(dateDayBeatFor(AGREED, at(-1))).toBeNull();
    expect(dateDayBeatFor(AGREED, at(30))).toBeNull();
  });

  it("stays silent through the date itself", () => {
    // The "you're there" look needs no push: the card is marked stale at
    // `agreedTime` and the system re-renders it on its own.
    expect(dateDayBeatFor(AGREED, at(0))).toBeNull();
    expect(dateDayBeatFor(AGREED, at(45))).toBeNull();
  });

  it("asks how it went at T+2h and only inside its window", () => {
    expect(dateDayBeatFor(AGREED, at(DATE_DAY_VIBE_AFTER_HOURS * 60))).toBe("vibe_check");
    expect(
      dateDayBeatFor(AGREED, at(DATE_DAY_VIBE_AFTER_HOURS * 60 + DATE_DAY_BEAT_WINDOW_MINUTES)),
    ).toBeNull();
  });

  it("ends at T+3h with a wider grace than the other beats", () => {
    expect(dateDayBeatFor(AGREED, at(DATE_DAY_END_HOURS * 60))).toBe("end");
    // A restarted process twenty minutes late still takes the card down; the
    // spotter and vibe beats would already have been missed by then, and that
    // asymmetry is the point — a dead card outlives a stale one.
    expect(dateDayBeatFor(AGREED, at(DATE_DAY_END_HOURS * 60 + 20))).toBe("end");
    expect(
      dateDayBeatFor(AGREED, at(DATE_DAY_END_HOURS * 60 + DATE_DAY_END_GRACE_MINUTES)),
    ).toBeNull();
  });

  it("never walks a late tick backwards through earlier beats", () => {
    // A tick waking up inside the end window must not also match the vibe
    // window it has already passed. This is what the reversed ladder buys, and
    // reordering the branches breaks exactly this case and nothing else.
    const insideEnd = at(DATE_DAY_END_HOURS * 60 + 5);
    expect(dateDayBeatFor(AGREED, insideEnd)).toBe("end");
  });

  it("the vibe question comes before the card dies, not with it", () => {
    // If these two ever collapse onto the same hour, the card asks and
    // disappears in the same tick.
    expect(DATE_DAY_VIBE_AFTER_HOURS).toBeLessThan(DATE_DAY_END_HOURS);
    const asked = AGREED.getTime() + DATE_DAY_VIBE_AFTER_HOURS * HOUR;
    const died = AGREED.getTime() + DATE_DAY_END_HOURS * HOUR;
    expect(died - asked).toBeGreaterThanOrEqual(HOUR);
  });
});
