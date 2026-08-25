import { beforeEach, describe, expect, it } from "vitest";

import { DATE_RADAR_LEAD_MINUTES, PROXIMITY_ARRIVED_RADIUS_M } from "@gennety/shared";

import {
  checkRadarWindow,
  defaultModeFor,
  estimateEta,
  formatEtaLocal,
  hasArrived,
  isTravelMode,
  recordPresence,
  resetRadarPresenceForTests,
  viewOfPeer,
} from "./date-radar.js";

const T = new Date("2026-09-03T16:00:00.000Z"); // 19:00 Kyiv
const MINUTE = 60_000;
const TZ = "Europe/Kyiv";

const VENUE = { lat: 50.4501, lng: 30.5234 };
/** ~40 m away — inside the 50 m arrival radius. */
const AT_DOOR = { lat: 50.45046, lng: 30.5234 };
/** ~1.1 km away — walkable. */
const NEARBY = { lat: 50.46, lng: 30.5234 };
/** ~5.6 km away — not walkable. */
const ACROSS_TOWN = { lat: 50.5, lng: 30.5234 };

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

describe("the pure checks", () => {
  describe("checkRadarWindow", () => {
    it("refuses before the radar opens", () => {
      expect(checkRadarWindow(T, at(-(DATE_RADAR_LEAD_MINUTES + 1) * MINUTE))).toBe(
        "too-early",
      );
    });

    it("opens exactly at T-45m", () => {
      expect(checkRadarWindow(T, at(-DATE_RADAR_LEAD_MINUTES * MINUTE))).toBe("ok");
    });

    it("still accepts a ping at the agreed moment", () => {
      expect(checkRadarWindow(T, T)).toBe("ok");
    });

    // The upper bound is where this differs from the Bump, on purpose: once the
    // date has started the two of them can see each other, so "on the way" has
    // stopped being information.
    it("closes the moment the date starts", () => {
      expect(checkRadarWindow(T, at(1))).toBe("too-late");
    });
  });

  describe("hasArrived", () => {
    it("counts a point at the door", () => {
      expect(hasArrived(AT_DOOR, VENUE)).toBe(true);
    });

    it("does not count a point a block away", () => {
      expect(hasArrived(NEARBY, VENUE)).toBe(false);
    });

    it("is tighter than the Bump's own radius", () => {
      expect(PROXIMITY_ARRIVED_RADIUS_M).toBeLessThan(100);
    });
  });

  describe("estimateEta", () => {
    it("reads a nearby point as a walk", () => {
      expect(estimateEta(NEARBY, VENUE).mode).toBe("walking");
    });

    it("reads a point across town as transit", () => {
      expect(estimateEta(ACROSS_TOWN, VENUE).mode).toBe("transit");
    });

    it("honours an explicit mode over the distance guess", () => {
      expect(estimateEta(ACROSS_TOWN, VENUE, "walking").mode).toBe("walking");
    });

    // Rounding up is the whole accuracy argument: told 18:55 and arriving 18:56
    // is a lie; told 18:56 and arriving 18:55 is not.
    it("rounds up to the whole minute", () => {
      const { minutes } = estimateEta(NEARBY, VENUE);
      expect(Number.isInteger(minutes)).toBe(true);
      expect(minutes).toBeGreaterThan(0);
    });

    it("is monotone in distance", () => {
      expect(estimateEta(ACROSS_TOWN, VENUE, "walking").minutes).toBeGreaterThan(
        estimateEta(NEARBY, VENUE, "walking").minutes,
      );
    });

    it("puts a 1 km walk in the quarter-hour a person would expect", () => {
      const { minutes } = estimateEta(NEARBY, VENUE, "walking");
      expect(minutes).toBeGreaterThanOrEqual(10);
      expect(minutes).toBeLessThanOrEqual(25);
    });

    it("refuses a mode it does not know", () => {
      expect(isTravelMode("teleport")).toBe(false);
      expect(defaultModeFor(0.4)).toBe("walking");
    });
  });

  it("formats the ETA in the pair's own city, not UTC", () => {
    expect(formatEtaLocal(T, TZ)).toBe("19:00");
  });
});

describe("what one side is told about the other", () => {
  beforeEach(() => {
    resetRadarPresenceForTests();
  });

  it("says nothing about a partner who has not pinged", () => {
    const view = viewOfPeer("m1", "A", T, TZ);
    expect(view).toEqual({ peer: "unknown", bothArrived: false });
  });

  it("reports a moving partner as en route, with a wall-clock time", () => {
    recordPresence("m1", "B", { arrived: false, etaAt: at(8 * MINUTE) }, T);
    const view = viewOfPeer("m1", "A", T, TZ);
    expect(view.peer).toBe("en_route");
    expect(view.peerEtaLocal).toBe("19:08");
  });

  it("reports an arrived partner without an ETA", () => {
    recordPresence("m1", "B", { arrived: true }, T);
    const view = viewOfPeer("m1", "A", T, TZ);
    expect(view.peer).toBe("arrived");
    expect(view.peerEtaLocal).toBeUndefined();
  });

  it("celebrates only when BOTH are there", () => {
    recordPresence("m1", "B", { arrived: true }, T);
    expect(viewOfPeer("m1", "A", T, TZ).bothArrived).toBe(false);
    recordPresence("m1", "A", { arrived: true }, T);
    expect(viewOfPeer("m1", "A", T, TZ).bothArrived).toBe(true);
  });

  // The point of reading the PEER's slot: a person pinging twice is one person.
  it("never reports the caller's own ping back as their partner", () => {
    recordPresence("m1", "A", { arrived: false, etaAt: at(3 * MINUTE) }, T);
    expect(viewOfPeer("m1", "A", T, TZ).peer).toBe("unknown");
  });

  it("keeps two matches apart", () => {
    recordPresence("m1", "B", { arrived: true }, T);
    expect(viewOfPeer("m2", "A", T, TZ).peer).toBe("unknown");
  });

  // A stale ETA is worse than none: "eight minutes away" was true a quarter of
  // an hour ago and reads as though it is true now.
  it("forgets a phone that has gone quiet", () => {
    recordPresence("m1", "B", { arrived: false, etaAt: at(8 * MINUTE) }, T);
    expect(viewOfPeer("m1", "A", at(20 * MINUTE), TZ).peer).toBe("unknown");
  });

  it("an arrival supersedes an earlier ETA rather than sitting beside it", () => {
    recordPresence("m1", "B", { arrived: false, etaAt: at(8 * MINUTE) }, T);
    recordPresence("m1", "B", { arrived: true, etaAt: at(8 * MINUTE) }, at(MINUTE));
    const view = viewOfPeer("m1", "A", at(MINUTE), TZ);
    expect(view.peer).toBe("arrived");
    expect(view.peerEtaLocal).toBeUndefined();
  });

  // The privacy boundary of the whole feature, asserted on the shape rather
  // than on a route: nothing that crosses between two people may carry a
  // position, at any resolution.
  it("carries no position, distance or address at any resolution", () => {
    recordPresence("m1", "B", { arrived: false, etaAt: at(8 * MINUTE) }, T);
    const wire = JSON.stringify(viewOfPeer("m1", "A", T, TZ));
    for (const forbidden of [
      "lat",
      "lng",
      "distance",
      "address",
      "metres",
      "meters",
      "km",
      "coord",
    ]) {
      expect(wire.toLowerCase()).not.toContain(forbidden);
    }
  });
});
