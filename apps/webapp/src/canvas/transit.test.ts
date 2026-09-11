import { describe, expect, it } from "vitest";

import { CANVAS_TABLES, stringsFor, type Lang } from "./i18n.js";
import { CANVAS_STATES, type CanvasState } from "./sheet.js";
import {
  ARRIVED_M,
  CITY_RANGE_M,
  WALKABLE_M,
  defaultModeFor,
  dockPresenceFor,
  dockShown,
  etaMinutes,
  formatTravelTime,
  travelMinutes,
  type DockPresence,
} from "./transit.js";

describe("travelMinutes", () => {
  it("walks at the radar's pace — the number the server would give", () => {
    // date-radar.ts: ceil(km × 1.35 / 4.8 × 60)
    expect(travelMinutes(1_000, "walking")).toBe(17);
    expect(travelMinutes(2_000, "walking")).toBe(34);
  });

  it("drives door to door: 2 km reads 9 minutes, not a flattering 7", () => {
    expect(travelMinutes(2_000, "driving")).toBe(9);
    expect(travelMinutes(10_000, "driving")).toBe(36);
  });

  it("rounds up, and never says zero", () => {
    expect(travelMinutes(0, "walking")).toBe(1);
    expect(travelMinutes(0, "driving")).toBe(2);
    for (const m of [50, 333, 1_234, 4_321]) {
      expect(travelMinutes(m, "walking")).toBeGreaterThanOrEqual(((m / 1000) * 1.35 * 60) / 4.8);
    }
  });

  it("does not let float noise add a minute to an exact result", () => {
    // 1.6 km × 1.35 / 4.8 × 60 is exactly 27, and computes as 27.000000000000004.
    expect(travelMinutes(1_600, "walking")).toBe(27);
  });
});

describe("etaMinutes", () => {
  it("has nothing to say beyond the city", () => {
    expect(etaMinutes(CITY_RANGE_M, "driving")).not.toBeNull();
    expect(etaMinutes(CITY_RANGE_M + 1, "driving")).toBeNull();
  });
});

describe("defaultModeFor", () => {
  it("walks what the radar would walk and drives the rest", () => {
    expect(defaultModeFor(WALKABLE_M - 1)).toBe("walking");
    expect(defaultModeFor(WALKABLE_M)).toBe("walking");
    expect(defaultModeFor(WALKABLE_M + 1)).toBe("driving");
  });
});

describe("dockPresenceFor", () => {
  it("is automatic in the departure window, on demand before it, and off otherwise", () => {
    const expected: Record<CanvasState, DockPresence> = {
      IDLE_EXPLORING: "off",
      DROP_PENDING_DECISION: "off",
      LOGISTICS_SCHEDULING: "off",
      DATE_SCHEDULED: "on-demand",
      DATE_RADAR_ACTIVE: "auto",
      DATE_BUMP_PENDING: "auto",
      DATE_IN_PROGRESS: "off",
      POST_DATE_FEEDBACK: "off",
    };
    for (const state of CANVAS_STATES) expect(dockPresenceFor(state, true), state).toBe(expected[state]);
  });

  it("never exists without a venue point", () => {
    for (const state of CANVAS_STATES) expect(dockPresenceFor(state, false), state).toBe("off");
  });
});

describe("dockShown", () => {
  it("stays up on its own in the window, and steps aside on arrival", () => {
    expect(dockShown({ presence: "auto", summoned: false, distanceM: null })).toBe(true);
    expect(dockShown({ presence: "auto", summoned: false, distanceM: 2_400 })).toBe(true);
    expect(dockShown({ presence: "auto", summoned: false, distanceM: ARRIVED_M + 1 })).toBe(true);
    expect(dockShown({ presence: "auto", summoned: false, distanceM: ARRIVED_M })).toBe(false);
  });

  it("comes back when the pin asks, even at the venue", () => {
    expect(dockShown({ presence: "auto", summoned: true, distanceM: 10 })).toBe(true);
  });

  it("waits for the pin before the window", () => {
    expect(dockShown({ presence: "on-demand", summoned: false, distanceM: 2_400 })).toBe(false);
    expect(dockShown({ presence: "on-demand", summoned: true, distanceM: 2_400 })).toBe(true);
  });

  it("never shows when off, summoned or not", () => {
    expect(dockShown({ presence: "off", summoned: true, distanceM: 2_400 })).toBe(false);
    expect(dockShown({ presence: "off", summoned: false, distanceM: null })).toBe(false);
  });
});

describe("formatTravelTime", () => {
  it("reads minutes, then hours and minutes", () => {
    const en = stringsFor("en");
    expect(formatTravelTime(9, en)).toBe("9 min");
    expect(formatTravelTime(59, en)).toBe("59 min");
    expect(formatTravelTime(60, en)).toBe("1 h");
    expect(formatTravelTime(84, en)).toBe("1 h 24 min");
  });

  it("leaves no placeholder behind in any language", () => {
    for (const lang of Object.keys(CANVAS_TABLES) as Lang[]) {
      const s = stringsFor(lang);
      for (const minutes of [1, 9, 60, 84, 125]) {
        for (const line of [s.dockEtaWalking, s.dockEtaDriving]) {
          const filled = line.replace("{time}", formatTravelTime(minutes, s));
          expect(filled, `${lang}/${minutes}`).not.toMatch(/\{\w+\}/);
        }
      }
    }
  });
});
