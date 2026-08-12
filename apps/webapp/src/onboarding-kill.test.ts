import { describe, expect, it } from "vitest";

import {
  KILL_CSS_VARS,
  KILL_STRIKE_DELAY_MS,
  KILL_TOTAL_MS,
  STAT_COUNT_UP_MS,
  STAT_CYCLE_INTERVAL_MS,
  iconKillPhase,
} from "./onboarding-kill.js";

describe("stats-icon kill timings", () => {
  it("finishes the whole beat inside one metric step", () => {
    // A strike still drawing when the next number starts counting would read as
    // two icons dying at once, which is exactly what "one app at a time" is not.
    expect(KILL_TOTAL_MS).toBeLessThan(STAT_CYCLE_INTERVAL_MS);
  });

  it("lands the strike exactly when the number lands", () => {
    // The icon going fully red and the first stroke arriving are one event; a
    // gap here is the beat visibly sagging between them.
    expect(KILL_STRIKE_DELAY_MS).toBe(STAT_COUNT_UP_MS);
  });

  it("leaves the crossed-out icon on screen before the next metric", () => {
    // Not merely "it fits": the finished X has to be readable for a moment, or
    // the payoff is gone the instant it arrives.
    expect(STAT_CYCLE_INTERVAL_MS - KILL_TOTAL_MS).toBeGreaterThanOrEqual(500);
  });

  it("publishes every timing CSS needs", () => {
    expect(KILL_CSS_VARS).toEqual({
      "--kill-count": "1250ms",
      "--kill-strike-delay": "1250ms",
      "--kill-strike-stagger": "130ms",
      "--kill-strike-draw": "380ms",
    });
  });
});

describe("iconKillPhase", () => {
  it("kills the icon under the metric that is counting", () => {
    expect(iconKillPhase(0, 0, false)).toBe("killing");
    expect(iconKillPhase(1, 1, false)).toBe("killing");
    expect(iconKillPhase(2, 2, false)).toBe("killing");
  });

  it("leaves the apps ahead of the drum untouched", () => {
    expect(iconKillPhase(1, 0, false)).toBe("alive");
    expect(iconKillPhase(2, 0, false)).toBe("alive");
    expect(iconKillPhase(2, 1, false)).toBe("alive");
  });

  it("holds every icon it has already been through", () => {
    expect(iconKillPhase(0, 1, false)).toBe("killed");
    expect(iconKillPhase(0, 2, false)).toBe("killed");
    expect(iconKillPhase(1, 2, false)).toBe("killed");
  });

  it("never replays the drama after the first lap", () => {
    // The drum keeps cycling the numbers forever. Re-killing icon 0 on lap two
    // would read as the app coming back to life just to die again.
    for (const cycleIndex of [0, 1, 2]) {
      for (const iconIndex of [0, 1, 2]) {
        expect(iconKillPhase(iconIndex, cycleIndex, true)).toBe("killed");
      }
    }
  });
});
