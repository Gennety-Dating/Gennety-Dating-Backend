import { describe, expect, it } from "vitest";

import { CLOCK_SAMPLES_KEPT, createServerClock, parseServerTime } from "./clock.js";

/** A phone whose clock is `skew` ms behind the server's, on a controllable local clock. */
function rig(skew: number) {
  let local = 1_000_000;
  const clock = createServerClock({ local: () => local });
  const read = (up: number, down: number) => {
    const sentAt = local;
    const serverNow = sentAt + up + skew;
    local = sentAt + up + down;
    clock.record({ sentAt, receivedAt: local, serverNow });
  };
  return { clock, read, advance: (ms: number) => (local += ms), at: () => local };
}

describe("the server clock", () => {
  it("is the local clock until it has heard from the server", () => {
    const { clock, at } = rig(0);
    expect(clock.offset()).toBeNull();
    expect(clock.now()).toBe(at());
  });

  it("finds the offset exactly on a symmetric round trip", () => {
    const { clock, read, at } = rig(2_500);
    read(40, 40);
    expect(clock.offset()).toBe(2_500);
    expect(clock.now()).toBe(at() + 2_500);
  });

  it("is off by at most half the round trip when the path is lopsided", () => {
    const { clock, read } = rig(-800);
    read(300, 20);
    expect(Math.abs(clock.offset()! - -800)).toBeLessThanOrEqual(160);
  });

  it("trusts the shortest round trip among recent samples", () => {
    const { clock, read } = rig(1_000);
    read(400, 50); // slow and lopsided: 175 ms off
    read(10, 10); // fast: exact
    read(250, 30);
    expect(clock.offset()).toBe(1_000);
    expect(clock.uncertainty()).toBe(20);
  });

  it(`keeps only the last ${CLOCK_SAMPLES_KEPT} samples`, () => {
    const { clock, read } = rig(0);
    read(1, 1); // the best, and the oldest
    for (let i = 0; i < CLOCK_SAMPLES_KEPT; i += 1) read(100, 20);
    expect(clock.uncertainty()).toBe(120);
  });

  it("ignores nonsense samples", () => {
    const clock = createServerClock({ local: () => 0 });
    clock.record({ sentAt: 10, receivedAt: 5, serverNow: 99 });
    clock.record({ sentAt: 10, receivedAt: 20, serverNow: Number.NaN });
    expect(clock.offset()).toBeNull();
  });

  it("uses a long-poll's one-way hint only while it has nothing better", () => {
    const { clock, read } = rig(700);
    clock.hint(1_000_000, 1_000_000 + 650);
    expect(clock.offset()).toBe(650);
    read(15, 15);
    expect(clock.offset()).toBe(700);
  });

  it("puts a phone that heard late mid-scene, never back at the start", () => {
    const { clock, read, advance } = rig(3_000);
    read(20, 20);
    const startAt = clock.now() + 900;
    advance(2_400); // the answer took its time
    expect(clock.now() - startAt).toBe(1_500);
  });

  it("parses the API's ISO time", () => {
    expect(parseServerTime("2026-09-29T18:00:00.250Z")).toBe(Date.UTC(2026, 8, 29, 18, 0, 0, 250));
    expect(parseServerTime(null)).toBeNaN();
  });
});
