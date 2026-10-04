import { describe, expect, it } from "vitest";

import { GATE_START, cueFromHold, cueFromState, type CeremonyGate } from "./cue.js";

const CEREMONY = { startAt: "2026-09-29T18:00:01.000Z", role: "A" as const, serverNow: "2026-09-29T18:00:00.100Z" };
const unverified = { verified: false, holdInFlight: false, serverNow: 0 };
const verified = { verified: true, holdInFlight: false, serverNow: 42_000 };

function seen(): CeremonyGate {
  return cueFromState(GATE_START, unverified).gate;
}

describe("the ceremony cue", () => {
  it("plays the hold's own scene with its role and the server's start", () => {
    const step = cueFromHold(seen(), CEREMONY);
    expect(step.cue).toEqual({ role: "A", startAt: Date.parse(CEREMONY.startAt), synced: true });
    expect(step.gate.played).toBe(true);
  });

  it("never plays twice — not a second answer, not the poll behind it", () => {
    const first = cueFromHold(seen(), CEREMONY);
    expect(cueFromHold(first.gate, { ...CEREMONY, role: "B" }).cue).toBeNull();
    expect(cueFromState(first.gate, verified).cue).toBeNull();
  });

  it("degrades: a sync learned from a read after seeing the date unverified plays locally as B", () => {
    const step = cueFromState(seen(), verified);
    expect(step.cue).toEqual({ role: "B", startAt: 42_000, synced: false });
    expect(cueFromState(step.gate, verified).cue).toBeNull();
  });

  it("does not play for a terminal opened after the sync", () => {
    const step = cueFromState(GATE_START, verified);
    expect(step.cue).toBeNull();
    expect(step.gate.played).toBe(false);
    // …and a later read changes nothing: it never saw the date unverified.
    expect(cueFromState(step.gate, verified).cue).toBeNull();
  });

  it("lets a hold still in flight bring its synchronised scene first", () => {
    const gate = seen();
    expect(cueFromState(gate, { ...verified, holdInFlight: true }).cue).toBeNull();
    // The answer then carries the scene…
    expect(cueFromHold(gate, CEREMONY).cue?.synced).toBe(true);
    // …or does not (the pre-long-poll server), and the next read degrades.
    expect(cueFromHold(gate, undefined).cue).toBeNull();
    expect(cueFromState(gate, verified).cue?.role).toBe("B");
  });

  it("ignores an answer without a usable ceremony", () => {
    expect(cueFromHold(seen(), null).cue).toBeNull();
    expect(cueFromHold(seen(), { ...CEREMONY, startAt: "soon" }).cue).toBeNull();
    expect(cueFromHold(seen(), { ...CEREMONY, role: "C" as never }).cue).toBeNull();
  });
});
