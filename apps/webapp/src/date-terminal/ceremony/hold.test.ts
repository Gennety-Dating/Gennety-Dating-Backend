import { describe, expect, it } from "vitest";

import { HOLD_COMMIT_MS, HOLD_IDLE, holdProgress, holdStep, type HoldEvent, type HoldState } from "./hold.js";

function run(events: HoldEvent[], from: HoldState = HOLD_IDLE): { state: HoldState; commits: number } {
  let state = from;
  let commits = 0;
  for (const e of events) {
    const step = holdStep(state, e);
    state = step.state;
    if (step.commit) commits += 1;
  }
  return { state, commits };
}

describe("the hold", () => {
  it("is 0.6 s", () => {
    expect(HOLD_COMMIT_MS).toBe(600);
  });

  it("commits once the finger has stayed down for the full fill", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "tick", at: 300 },
      { type: "tick", at: 599 },
      { type: "tick", at: 600 },
      { type: "tick", at: 616 },
    ]);
    expect(r.commits).toBe(1);
    expect(r.state.kind).toBe("waiting");
  });

  it("cancels when the finger lifts early", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "tick", at: 400 },
      { type: "release", at: 450 },
      { type: "tick", at: 700 },
    ]);
    expect(r.commits).toBe(0);
    expect(r.state).toEqual(HOLD_IDLE);
  });

  it("still commits a release that beat the tick at the mark", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "tick", at: 590 },
      { type: "release", at: 605 },
    ]);
    expect(r.commits).toBe(1);
  });

  it("does not cancel when the finger lifts while the server waits", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "tick", at: 600 },
      { type: "release", at: 2_000 },
      { type: "press", at: 3_000 },
      { type: "tick", at: 3_700 },
    ]);
    expect(r.commits).toBe(1);
    expect(r.state.kind).toBe("waiting");
  });

  it("comes back to rest when the server answers, ready for another hold", () => {
    const r = run([{ type: "press", at: 0 }, { type: "tick", at: 600 }, { type: "settle" }, { type: "press", at: 9_000 }, { type: "tick", at: 9_600 }]);
    expect(r.commits).toBe(2);
  });

  it("fills linearly, stays full while waiting, empties at rest", () => {
    expect(holdProgress({ kind: "pressing", since: 100 }, 400)).toBeCloseTo(0.5, 9);
    expect(holdProgress({ kind: "pressing", since: 100 }, 5_000)).toBe(1);
    expect(holdProgress({ kind: "waiting", since: 0 }, 0)).toBe(1);
    expect(holdProgress(HOLD_IDLE, 0)).toBe(0);
  });
});
