import { describe, expect, it } from "vitest";

import { createFailureTracker } from "./failure-tracker.js";

const MAX = 3;

describe("createFailureTracker", () => {
  it("counts consecutive refusals of the same action", () => {
    const t = createFailureTracker(MAX);
    expect(t.note("u1", "partner_pay_ticket")).toBe(1);
    expect(t.note("u1", "partner_pay_ticket")).toBe(2);
    expect(t.note("u1", "partner_pay_ticket")).toBe(3);
  });

  it("keeps retrying below the ceiling", () => {
    const t = createFailureTracker(MAX);
    t.note("u1", "partner_pay_ticket");
    t.note("u1", "partner_pay_ticket");
    // Two refusals is a hiccup, not a dead end — a provider blip must not end
    // the demo.
    expect(t.abandoned("u1", "partner_pay_ticket")).toBe(false);
  });

  it("gives up at the ceiling — the whole point of the thing", () => {
    const t = createFailureTracker(MAX);
    for (let i = 0; i < MAX; i += 1) t.note("u1", "partner_pay_ticket");
    expect(t.abandoned("u1", "partner_pay_ticket")).toBe(true);
  });

  it("resets when the state moves on to a different action", () => {
    const t = createFailureTracker(MAX);
    for (let i = 0; i < MAX; i += 1) t.note("u1", "partner_pay_ticket");
    // The calendar is a different step; whatever broke the ticket settle has
    // nothing to say about it.
    expect(t.note("u1", "partner_counter_slots")).toBe(1);
    expect(t.abandoned("u1", "partner_counter_slots")).toBe(false);
  });

  it("does not abandon a different action just because one was abandoned", () => {
    const t = createFailureTracker(MAX);
    for (let i = 0; i < MAX; i += 1) t.note("u1", "partner_pay_ticket");
    expect(t.abandoned("u1", "partner_venue")).toBe(false);
  });

  it("keeps visitors apart", () => {
    const t = createFailureTracker(MAX);
    for (let i = 0; i < MAX; i += 1) t.note("u1", "partner_pay_ticket");
    expect(t.abandoned("u2", "partner_pay_ticket")).toBe(false);
    expect(t.note("u2", "partner_pay_ticket")).toBe(1);
  });

  it("clear() puts a visitor back in play — /restart must always work", () => {
    const t = createFailureTracker(MAX);
    for (let i = 0; i < MAX; i += 1) t.note("u1", "partner_pay_ticket");
    t.clear("u1");
    expect(t.abandoned("u1", "partner_pay_ticket")).toBe(false);
    expect(t.note("u1", "partner_pay_ticket")).toBe(1);
  });

  it("a success mid-streak clears it, so the next failure starts from one", () => {
    const t = createFailureTracker(MAX);
    t.note("u1", "partner_pay_ticket");
    t.note("u1", "partner_pay_ticket");
    t.clear("u1"); // the driver clears on every successful action
    expect(t.note("u1", "partner_pay_ticket")).toBe(1);
    expect(t.abandoned("u1", "partner_pay_ticket")).toBe(false);
  });

  describe("giving up is a pause, not a retirement", () => {
    const COOLDOWN = 120_000;
    const T0 = 1_000_000;

    function abandonedTracker() {
      const t = createFailureTracker(MAX, COOLDOWN);
      for (let i = 0; i < MAX; i += 1) t.note("u1", "pitch", T0);
      return t;
    }

    it("lets one probe through once the cooldown has elapsed", () => {
      const t = abandonedTracker();
      expect(t.abandoned("u1", "pitch", T0 + COOLDOWN - 1)).toBe(true);
      // The cause may have healed on its own — an embedding finished building,
      // a provider came back. Parking the demo forever is worse than a slow
      // retry, and the visitor is still sitting there.
      expect(t.abandoned("u1", "pitch", T0 + COOLDOWN)).toBe(false);
    });

    it("a failed probe pushes the deadline out instead of reopening the flood", () => {
      const t = abandonedTracker();
      const probeAt = T0 + COOLDOWN;
      expect(t.note("u1", "pitch", probeAt)).toBe(MAX + 1);
      expect(t.abandoned("u1", "pitch", probeAt + 1)).toBe(true);
      expect(t.abandoned("u1", "pitch", probeAt + COOLDOWN)).toBe(false);
    });

    it("a failed probe cannot re-announce the give-up", () => {
      const t = abandonedTracker();
      // The driver announces only on the tick where the streak first equals the
      // ceiling, so the count must keep climbing rather than resetting to 1 —
      // otherwise every cooldown would send the visitor another "I'm stuck".
      expect(t.note("u1", "pitch", T0 + COOLDOWN)).not.toBe(MAX);
    });

    it("a probe that succeeds clears the visitor completely", () => {
      const t = abandonedTracker();
      t.clear("u1"); // the driver clears on any successful action
      expect(t.abandoned("u1", "pitch", T0 + 1)).toBe(false);
      expect(t.note("u1", "pitch", T0 + 1)).toBe(1);
    });
  });
});
