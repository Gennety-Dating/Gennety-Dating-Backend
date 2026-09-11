import { describe, expect, it } from "vitest";

import {
  GEOFENCE_RADIUS_M,
  distanceMeters,
  formatClock,
  formatDistance,
  syncOpensAt,
  syncUnlocked,
  terminalPhase,
  wantsLocation,
  withinGeofence,
  type TerminalInput,
} from "./terminal-state.js";

const VENUE = { lat: 50.4486, lng: 30.5133 };
const UNITS = { metres: "{n} m", kilometres: "{n} km" };

function input(overrides: Partial<TerminalInput> = {}): TerminalInput {
  return {
    matchId: "m1",
    state: "DATE_BUMP_PENDING",
    stateMatchId: "m1",
    venue: VENUE,
    bumpVerified: false,
    distanceM: 40,
    motion: "idle",
    ...overrides,
  };
}

describe("the geofence", () => {
  it("mirrors the server's 100 m", () => {
    expect(GEOFENCE_RADIUS_M).toBe(100);
  });

  it("uses the server's rule on raw distance: ≤ radius is in", () => {
    expect(withinGeofence(100)).toBe(true);
    expect(withinGeofence(100.4)).toBe(false);
    expect(withinGeofence(null)).toBe(false);
  });

  it("measures real distance on the ground", () => {
    // ~111 m per 0.001° of latitude.
    const north = { lat: VENUE.lat + 0.001, lng: VENUE.lng };
    expect(distanceMeters(VENUE, north)).toBeGreaterThan(105);
    expect(distanceMeters(VENUE, north)).toBeLessThan(118);
    expect(distanceMeters(VENUE, VENUE)).toBe(0);
  });
});

describe("terminalPhase", () => {
  it("keeps Contact Sync locked until the window is open", () => {
    for (const state of ["DATE_SCHEDULED", "DATE_RADAR_ACTIVE"] as const) {
      const phase = terminalPhase(input({ state, distanceM: 0 }));
      expect(phase).toBe("early");
      expect(syncUnlocked(phase)).toBe(false);
    }
  });

  it("keeps it locked outside 100 m, or with no fix at all", () => {
    expect(terminalPhase(input({ distanceM: 180 }))).toBe("approach");
    expect(terminalPhase(input({ distanceM: null }))).toBe("approach");
    expect(syncUnlocked("approach")).toBe(false);
  });

  it("unlocks inside 100 m once the window is open, and arms on request", () => {
    expect(terminalPhase(input())).toBe("ready");
    expect(terminalPhase(input({ motion: "armed" }))).toBe("armed");
    expect(syncUnlocked("ready")).toBe(true);
    expect(syncUnlocked("armed")).toBe(true);
  });

  it("drops out of armed the moment the phone walks out of range", () => {
    expect(terminalPhase(input({ motion: "armed", distanceM: 140 }))).toBe("approach");
  });

  it("shows the sync as done whatever the GPS says afterwards", () => {
    expect(terminalPhase(input({ bumpVerified: true, distanceM: null }))).toBe("synced");
    expect(terminalPhase(input({ state: "DATE_IN_PROGRESS", distanceM: 9000 }))).toBe("synced");
  });

  it("is closed for a stale button or a date that is over", () => {
    expect(terminalPhase(input({ stateMatchId: "m0" }))).toBe("closed");
    expect(terminalPhase(input({ stateMatchId: null }))).toBe("closed");
    expect(terminalPhase(input({ state: "POST_DATE_FEEDBACK" }))).toBe("closed");
    expect(terminalPhase(input({ state: "IDLE_EXPLORING" }))).toBe("closed");
  });

  it("refuses to gate against a venue it cannot place", () => {
    expect(terminalPhase(input({ venue: null }))).toBe("no-venue-point");
  });

  it("watches the position only while it can matter", () => {
    expect(wantsLocation("early")).toBe(true);
    expect(wantsLocation("armed")).toBe(true);
    expect(wantsLocation("synced")).toBe(false);
    expect(wantsLocation("closed")).toBe(false);
  });
});

describe("formatting", () => {
  it("rounds distance UP, so the number never claims closer than the lock", () => {
    expect(formatDistance(101, "en", UNITS)).toBe("105 m");
    expect(formatDistance(100, "en", UNITS)).toBe("100 m");
    expect(formatDistance(0, "en", UNITS)).toBe("5 m");
    expect(formatDistance(1420, "en", UNITS)).toBe("1.5 km");
    expect(formatDistance(1420, "ru", UNITS)).toBe("1,5 km");
  });

  it("opens the sync 15 minutes before the date", () => {
    const agreed = new Date("2026-09-11T16:00:00Z");
    expect(syncOpensAt(agreed).toISOString()).toBe("2026-09-11T15:45:00.000Z");
  });

  it("prints a 24h clock in every language", () => {
    const at = new Date(2026, 8, 11, 18, 45);
    expect(formatClock(at, "en")).toBe("18:45");
    expect(formatClock(at, "de")).toBe("18:45");
  });
});
