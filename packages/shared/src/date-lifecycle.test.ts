import { describe, expect, it } from "vitest";

import {
  DATE_DAY_BEAT_WINDOW_MINUTES,
  DATE_DAY_END_GRACE_MINUTES,
  DATE_DAY_END_HOURS,
  DATE_DAY_SPOTTER_LEAD_MINUTES,
  DATE_DAY_VIBE_AFTER_HOURS,
  dateDayBeatFor,
} from "./date-lifecycle.js";
import {
  COORD_OFFER_HOURS,
  DATE_ALERT_HOURS,
  PRE_DATE_SAFETY_HOURS,
  PRE_DATE_WINGMAN_HOURS,
  PROXY_CLOSE_AFTER_HOURS,
  PROXY_OPEN_HOURS,
} from "./constants.js";

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

/**
 * The pre-date schedule, as a set of ORDERING facts rather than a list of
 * numbers.
 *
 * Every offset below lives in a different file from the sweep that reads it —
 * `constants.ts` feeds `services/coordination.ts`, `services/pre-date-safety.ts`
 * and `services/date-lifecycle.ts`, three independent ticks that never consult
 * each other. Nothing in the code stops two of them landing on the same minute;
 * what stops it is this test. Each assertion names the failure it prevents, so
 * a future retiming that breaks one is told what it broke rather than which
 * number changed.
 *
 * Deliberately relative, not absolute: moving the whole schedule earlier is a
 * product decision that should not have to fight a test, while collapsing two
 * beats onto one moment is a message storm on a real person's phone.
 */
describe("the pre-date schedule", () => {
  /** Hours before `agreedTime`, largest first — the order a user lives them. */
  const BEATS: ReadonlyArray<readonly [string, number]> = [
    ["ice-breakers + emergency window", DATE_ALERT_HOURS],
    ["coordination offer", COORD_OFFER_HOURS],
    ["wingman reveal", PRE_DATE_WINGMAN_HOURS],
    ["anonymous chat opens", PROXY_OPEN_HOURS],
    ["spotter sign", DATE_DAY_SPOTTER_LEAD_MINUTES / 60],
  ];

  it("runs strictly in order, with nothing arriving twice at one moment", () => {
    for (let i = 1; i < BEATS.length; i++) {
      const [prevName, prev] = BEATS[i - 1]!;
      const [name, current] = BEATS[i]!;
      expect(
        current,
        `"${name}" must land strictly after "${prevName}"`,
      ).toBeLessThan(prev);
    }
  });

  it("gives the pair real time to answer the coordination offer", () => {
    // The offer asks a question whose two contact variants need the PARTNER to
    // notice a card and tap it. If the anonymous-chat fallback opened right
    // behind it, the fork would resolve before the second person ever looked
    // at their phone — which is what T-60m/T-30m did.
    expect(COORD_OFFER_HOURS - PROXY_OPEN_HOURS).toBeGreaterThanOrEqual(1);
  });

  it("offers coordination only once the venue can no longer move", () => {
    // A venue change must settle by T-5h (`VENUE_CHANGE_TTL_HOURS`' effective
    // deadline). An offer sent before that could name a place the pair is
    // still in the middle of swapping.
    expect(COORD_OFFER_HOURS).toBeLessThan(DATE_ALERT_HOURS);
  });

  it("keeps the chat-open beat off the spotter beat", () => {
    // Both push the same Live Activity from two different sweeps
    // (`openProxies` and `dateDayBeatFor`). Landing them in one tick left the
    // card showing whichever APNs delivered last.
    const chatOpenMinutes = PROXY_OPEN_HOURS * 60;
    expect(
      chatOpenMinutes - DATE_DAY_SPOTTER_LEAD_MINUTES,
    ).toBeGreaterThanOrEqual(DATE_DAY_BEAT_WINDOW_MINUTES);
  });

  it("opens the anonymous chat before the safety brief stops being useful", () => {
    // The brief tells a woman where she is going and that she can bail; the
    // chat is how she says "I'm five minutes late" without handing over a
    // handle. The brief landing AFTER the chat would introduce a tool she has
    // already been given.
    expect(PROXY_OPEN_HOURS).toBeLessThan(PRE_DATE_SAFETY_HOURS);
  });

  it("keeps the chat open across the whole meeting, not just the approach", () => {
    expect(PROXY_OPEN_HOURS + PROXY_CLOSE_AFTER_HOURS).toBeGreaterThanOrEqual(3);
  });
});
