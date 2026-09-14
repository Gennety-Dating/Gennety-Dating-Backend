import { describe, expect, it } from "vitest";
import { createResponseEpoch } from "./request-epoch";

/** A13-L23 — a poll that left before a save must not paint over it. */
describe("createResponseEpoch", () => {
  it("lets an undisturbed read paint", () => {
    const epoch = createResponseEpoch();
    const ticket = epoch.begin();
    expect(epoch.claim(ticket)).toBe(true);
  });

  it("drops a read that was in flight when a write started", () => {
    const epoch = createResponseEpoch();
    const poll = epoch.begin();
    epoch.invalidate(); // the save starts while the poll is still out
    expect(epoch.claim(poll)).toBe(false);
  });

  it("drops a read that started during a write once the write's answer lands", () => {
    const epoch = createResponseEpoch();
    epoch.invalidate(); // save starts
    const poll = epoch.begin(); // an interval fires mid-save
    epoch.invalidate(); // the save's own answer is applied
    expect(epoch.claim(poll)).toBe(false);
  });

  it("drops an older read that lands after a newer one has painted", () => {
    const epoch = createResponseEpoch();
    const older = epoch.begin();
    const newer = epoch.begin();
    expect(epoch.claim(newer)).toBe(true);
    expect(epoch.claim(older)).toBe(false);
  });

  it("does not starve a slow read just because the next one has left", () => {
    // The ticket gate's read waits on photos and can outlast its interval.
    const epoch = createResponseEpoch();
    const slow = epoch.begin();
    const next = epoch.begin();
    expect(epoch.claim(slow)).toBe(true);
    // …and the newer one still paints after it, so the latest word wins.
    expect(epoch.claim(next)).toBe(true);
  });

  it("lets the first read after a write paint", () => {
    const epoch = createResponseEpoch();
    epoch.invalidate();
    const next = epoch.begin();
    expect(epoch.claim(next)).toBe(true);
  });
});
