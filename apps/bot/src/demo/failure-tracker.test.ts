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
});
