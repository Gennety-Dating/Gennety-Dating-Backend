import { describe, expect, it } from "vitest";

import {
  backoffFor,
  POLL_ERROR_BASE_MS,
  POLL_ERROR_MAX_MS,
  POLL_FAST_MS,
  POLL_IDLE_MS,
  pollIntervalFor,
} from "./poll.js";
import { CANVAS_STATES } from "./sheet.js";

describe("pollIntervalFor", () => {
  it("polls fast only where the answer can change without the user", () => {
    expect(pollIntervalFor("DATE_RADAR_ACTIVE")).toBe(POLL_FAST_MS);
    expect(pollIntervalFor("DATE_BUMP_PENDING")).toBe(POLL_FAST_MS);
  });

  // The canvas is a screen people leave open, so a flat fast poll is a cost
  // paid mostly by users waiting on a drop that happens once an evening.
  it("leaves every other state slow", () => {
    const fast = new Set(["DATE_RADAR_ACTIVE", "DATE_BUMP_PENDING"]);
    for (const state of CANVAS_STATES) {
      if (fast.has(state)) continue;
      expect(pollIntervalFor(state), state).toBe(POLL_IDLE_MS);
    }
  });

  it("keeps the fast cadence genuinely faster", () => {
    expect(POLL_FAST_MS).toBeLessThan(POLL_IDLE_MS);
  });
});

describe("backoffFor", () => {
  it("starts at the base and doubles", () => {
    expect(backoffFor(0)).toBe(POLL_ERROR_BASE_MS);
    expect(backoffFor(1)).toBe(POLL_ERROR_BASE_MS);
    expect(backoffFor(2)).toBe(POLL_ERROR_BASE_MS * 2);
    expect(backoffFor(3)).toBe(POLL_ERROR_BASE_MS * 4);
  });

  // A user who was offline for an hour must not then wait an hour more, so
  // the backoff caps rather than growing forever.
  it("caps, and never overflows into an absurd wait", () => {
    expect(backoffFor(20)).toBe(POLL_ERROR_MAX_MS);
    expect(backoffFor(1000)).toBe(POLL_ERROR_MAX_MS);
    expect(Number.isFinite(backoffFor(1000))).toBe(true);
  });

  it("never returns a value that would busy-loop", () => {
    for (let i = -5; i < 40; i++) expect(backoffFor(i)).toBeGreaterThanOrEqual(1000);
  });
});
