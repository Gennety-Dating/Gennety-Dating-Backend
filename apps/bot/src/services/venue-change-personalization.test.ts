/**
 * The pure half of the board's personal ordering: what counts as "near where
 * this person goes", and the promise that reordering can never change WHICH
 * cards the pair is looking at.
 *
 * Offsets are built from metres so each case reads as the street it models.
 */
import { describe, expect, it } from "vitest";

import {
  NO_AFFINITY,
  affinityOf,
  personalizeOrder,
  type AffinityAnchor,
  type RankableVenue,
} from "./venue-change-personalization.js";

/** Kyiv-ish origin; the maths is local, the city only makes it readable. */
const ORIGIN = { lat: 50.4501, lng: 30.5234 };

/** Metres north of the origin, as a latitude offset. */
function north(metres: number): number {
  return ORIGIN.lat + metres / 111_320;
}

function venue(id: string, metresNorth: number): RankableVenue & { key: string } {
  return { key: id, placeId: id, lat: north(metresNorth), lng: ORIGIN.lng };
}

function anchor(metresNorth: number, visits: number): AffinityAnchor {
  return { lat: north(metresNorth), lng: ORIGIN.lng, visits };
}

describe("affinityOf", () => {
  it("is strongest on the doorstep and decays with distance", () => {
    const anchors = [anchor(0, 12)];
    const here = affinityOf(venue("a", 0), anchors);
    const nearby = affinityOf(venue("b", 700), anchors);
    const far = affinityOf(venue("c", 3000), anchors);

    expect(here).toBeCloseTo(1, 5);
    // One decay length ⇒ 1/e of the pull.
    expect(nearby).toBeCloseTo(Math.exp(-1), 2);
    expect(far).toBeLessThan(0.02);
    expect(here).toBeGreaterThan(nearby);
    expect(nearby).toBeGreaterThan(far);
  });

  it("weights a place by how often it is visited, up to a cap", () => {
    const rare = affinityOf(venue("a", 0), [anchor(0, 3)]);
    const usual = affinityOf(venue("a", 0), [anchor(0, 12)]);
    const obsessive = affinityOf(venue("a", 0), [anchor(0, 400)]);

    expect(rare).toBeLessThan(usual);
    // Past the cap one café cannot out-shout every other anchor.
    expect(obsessive).toBeCloseTo(usual, 5);
  });

  it("takes the strongest anchor, not the sum of a weak cluster", () => {
    const one = affinityOf(venue("a", 0), [anchor(0, 12)]);
    const crowd = affinityOf(venue("a", 0), [
      anchor(900, 12),
      anchor(950, 12),
      anchor(1000, 12),
      anchor(1050, 12),
    ]);
    expect(crowd).toBeLessThan(one);
    expect(crowd).toBeLessThan(1);
  });

  it("is zero for someone we know nothing about", () => {
    expect(affinityOf(venue("a", 0), [])).toBe(0);
  });
});

describe("personalizeOrder", () => {
  /** Five venues, already in the server's quality order. */
  const board = [venue("v0", 4000), venue("v1", 3000), venue("v2", 0), venue("v3", 100), venue("v4", 2000)];

  it("returns a permutation — never adds, drops or duplicates a card", () => {
    const ordered = personalizeOrder(board, {
      anchors: [anchor(0, 12)],
      beenThere: new Set(["v1"]),
    });

    expect(ordered).toHaveLength(board.length);
    expect([...ordered].map((v) => v.key).sort()).toEqual(board.map((v) => v.key).sort());
  });

  it("lifts the venue beside the places the viewer frequents", () => {
    const ordered = personalizeOrder(board, {
      anchors: [anchor(0, 12)],
      beenThere: new Set(),
    });
    const at = (key: string): number => ordered.map((v) => v.key).indexOf(key);

    // v2 sits on the anchor and starts third; it climbs past v1, which the
    // server ranked above it. v0 keeps the top — a full span of base score is
    // more than affinity is allowed to be worth.
    expect(at("v2")).toBeLessThan(at("v1"));
    expect(at("v2")).toBeLessThan(2);
    // v3, a hundred metres off the anchor, also climbs past the venues it
    // started behind that the viewer has no connection to.
    expect(at("v3")).toBeLessThan(at("v4"));
    expect(ordered[0]!.key).toBe("v0");
  });

  it("pushes down a venue the viewer has already been taken to", () => {
    const before = board.map((v) => v.key).indexOf("v0");
    const ordered = personalizeOrder(board, {
      anchors: [],
      beenThere: new Set(["v0"]),
    });
    expect(ordered.map((v) => v.key).indexOf("v0")).toBeGreaterThan(before);
  });

  it("cannot put a poor venue first on affinity alone", () => {
    // The last-ranked venue sits right on the viewer's doorstep. It climbs —
    // but the top of the list stays quality's to keep, which is the whole
    // reason the weight is a fraction of the span rather than the span.
    const far = 5000;
    const ordered = personalizeOrder(
      [
        venue("best", far),
        venue("second", far),
        venue("third", far),
        venue("fourth", far),
        venue("worst", 0),
      ],
      { anchors: [anchor(0, 12)], beenThere: new Set() },
    );
    const at = ordered.map((v) => v.key).indexOf("worst");

    expect(ordered[0]!.key).toBe("best");
    expect(at).toBeLessThan(4); // it moved
    expect(at).toBeGreaterThan(0); // but not to the front
  });

  it("leaves the order exactly as it found it when nothing is known", () => {
    expect(personalizeOrder(board, NO_AFFINITY).map((v) => v.key)).toEqual(
      board.map((v) => v.key),
    );
  });

  it("is stable: equal scores keep the server's order", () => {
    // Every venue equidistant from the anchor ⇒ identical personal scores.
    const ring = [venue("a", 1000), venue("b", 1000), venue("c", 1000)];
    expect(
      personalizeOrder(ring, { anchors: [anchor(0, 12)], beenThere: new Set() }).map(
        (v) => v.key,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("handles a board too short to reorder", () => {
    expect(personalizeOrder([], NO_AFFINITY)).toEqual([]);
    const one = [venue("only", 0)];
    expect(personalizeOrder(one, { anchors: [anchor(0, 12)], beenThere: new Set() })).toEqual(
      one,
    );
  });

  it("gives both sides of a pair the same cards in different orders", () => {
    // The whole point: the SET is the pair's, the ORDER is each viewer's.
    const mine = personalizeOrder(board, { anchors: [anchor(0, 12)], beenThere: new Set() });
    const theirs = personalizeOrder(board, {
      anchors: [anchor(4000, 12)],
      beenThere: new Set(),
    });

    expect(mine.map((v) => v.key)).not.toEqual(theirs.map((v) => v.key));
    expect(mine.map((v) => v.key).sort()).toEqual(theirs.map((v) => v.key).sort());
  });
});
