/**
 * Party Mode's pure core (LAUNCH_EVENTS §9.2).
 *
 * Everything here runs without a database, a clock or an event, which is the
 * whole reason `planCurrentRound` and `selectRoundPairings` are functions of
 * their arguments. The properties worth guarding are the ones that fail
 * SILENTLY in a room: a round that opens twice, a pair the product already
 * banned being introduced anyway, two people meeting for a second time while
 * someone else stands alone, and the league gate quietly refusing most of a
 * party because it was calibrated for choosing one person a week.
 */
import { describe, expect, it } from "vitest";

import {
  EVENT_LEAGUE_FLOOR,
  assignSpots,
  pairKey,
  planCurrentRound,
  selectRoundPairings,
  staticMission,
  type RoundConfig,
} from "./event-rounds.js";
import type { BatchUser } from "./match-engine.js";

const CONFIG: RoundConfig = { intervalMin: 35, durationMin: 20, firstRoundOffsetMin: 30 };

const START = new Date("2026-09-12T18:00:00.000Z");
const END = new Date("2026-09-12T23:00:00.000Z");
const EVENT = { startsAt: START, endsAt: END };

function at(minutesAfterStart: number): Date {
  return new Date(START.getTime() + minutesAfterStart * 60_000);
}

let seq = 0;
function user(overrides: Partial<BatchUser> = {}): BatchUser {
  seq += 1;
  return {
    id: `u${seq}`,
    age: 25,
    gender: "male",
    major: null,
    preference: "women",
    universityDomain: null,
    height: 180,
    negativeConstraints: null,
    psychologicalSummary: "likes long walks and short films",
    energyAxis: 0,
    orientationAxis: 0,
    embeddingLiteral: "[0.1,0.2]",
    eloScore: 500,
    standbyCount: 0,
    homeCityKey: "ua:kyiv",
    ageRangeMin: null,
    ageRangeMax: null,
    typePrefTags: null,
    appearanceTags: null,
    relationshipIntents: [],
    ...overrides,
  };
}

function distancesFor(users: BatchUser[], value = 0.3): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < users.length; i += 1) {
    for (let j = i + 1; j < users.length; j += 1) {
      map.set(pairKey(users[i]!.id, users[j]!.id), value);
    }
  }
  return map;
}

function select(users: BatchUser[], overrides: Partial<Parameters<typeof selectRoundPairings>[0]> = {}) {
  return selectRoundPairings({
    attendees: users,
    excludedPairKeys: new Set(),
    metThisEvent: new Set(),
    distances: distancesFor(users),
    sitOutCounts: new Map(),
    ...overrides,
  });
}

describe("planCurrentRound", () => {
  it("opens nothing before the first round", () => {
    expect(planCurrentRound(EVENT, at(0), CONFIG)).toBeNull();
    expect(planCurrentRound(EVENT, at(29), CONFIG)).toBeNull();
  });

  it("opens round 1 at the offset and holds it for the duration", () => {
    expect(planCurrentRound(EVENT, at(30), CONFIG)?.index).toBe(1);
    expect(planCurrentRound(EVENT, at(49), CONFIG)?.index).toBe(1);
  });

  // The gap is most of the evening, and it is the point: a round runs for 20
  // of every 35 minutes and the rest is people talking to each other.
  it("opens nothing between rounds", () => {
    expect(planCurrentRound(EVENT, at(50), CONFIG)).toBeNull();
    expect(planCurrentRound(EVENT, at(64), CONFIG)).toBeNull();
  });

  it("moves to round 2 one interval later", () => {
    expect(planCurrentRound(EVENT, at(65), CONFIG)?.index).toBe(2);
    expect(planCurrentRound(EVENT, at(100), CONFIG)?.index).toBe(3);
  });

  // Two ticks a minute apart inside one window MUST agree, because that
  // agreement plus @@unique(eventId, index) is the double-open guard.
  it("gives the same index for every instant inside one window", () => {
    const indices = new Set<number>();
    for (let m = 30; m < 50; m += 1) indices.add(planCurrentRound(EVENT, at(m), CONFIG)!.index);
    expect([...indices]).toEqual([1]);
  });

  it("never opens a round after the event has ended", () => {
    expect(planCurrentRound(EVENT, at(300), CONFIG)).toBeNull();
  });

  it("clamps a round that would run past the end of the event", () => {
    const shortEvent = { startsAt: START, endsAt: at(40) };
    const plan = planCurrentRound(shortEvent, at(31), CONFIG);
    expect(plan?.closesAt.toISOString()).toBe(at(40).toISOString());
  });
});

describe("selectRoundPairings", () => {
  it("pairs a compatible couple", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "female", preference: "men" });
    const { pairs, unpaired } = select([a, b]);
    expect(pairs).toHaveLength(1);
    expect(unpaired).toEqual([]);
  });

  it("does not pair two people who do not want each other's gender", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "male", preference: "women" });
    const { pairs, unpaired } = select([a, b]);
    expect(pairs).toEqual([]);
    expect(unpaired).toHaveLength(2);
  });

  // The same-city rule of `areMutuallyCompatible` is deliberately NOT applied:
  // they are standing in the venue, which outranks a profile column.
  it("pairs two attendees whose dating cities differ", () => {
    const a = user({ gender: "male", preference: "women", homeCityKey: "ua:kyiv" });
    const b = user({ gender: "female", preference: "men", homeCityKey: "ua:lviv" });
    expect(select([a, b]).pairs).toHaveLength(1);
  });

  it("never introduces a pair the core product has banned", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "female", preference: "men" });
    const { pairs, unpaired } = select([a, b], {
      excludedPairKeys: new Set([pairKey(a.id, b.id)]),
    });
    expect(pairs).toEqual([]);
    expect(unpaired).toHaveLength(2);
  });

  it("reads the ban in either direction", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "female", preference: "men" });
    // Only the mirror key — the caller must never have to canonicalise.
    const { pairs } = select([a, b], { excludedPairKeys: new Set([pairKey(b.id, a.id)]) });
    expect(pairs).toEqual([]);
  });

  it("does not introduce the same two people twice in one night", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "female", preference: "men" });
    const { pairs } = select([a, b], { metThisEvent: new Set([pairKey(a.id, b.id)]) });
    expect(pairs).toEqual([]);
  });

  it("skips a pair with no embedding distance rather than scoring it as distant", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "female", preference: "men" });
    const { pairs } = select([a, b], { distances: new Map() });
    expect(pairs).toEqual([]);
  });

  it("reports the odd one out rather than dropping them", () => {
    const a = user({ gender: "male", preference: "women" });
    const b = user({ gender: "female", preference: "men" });
    const c = user({ gender: "female", preference: "men" });
    const { pairs, unpaired } = select([a, b, c]);
    expect(pairs).toHaveLength(1);
    expect(unpaired).toHaveLength(1);
  });

  // The whole reason EVENT_LEAGUE_FLOOR exists: at 0.05 the weekly engine
  // would refuse most of a room, and standing alone is the alternative.
  it("lifts the league floor so a wide attractiveness gap is not fatal", () => {
    const a = user({ gender: "male", preference: "women", eloScore: 800 });
    const b = user({ gender: "female", preference: "men", eloScore: 200 });
    const lifted = select([a, b]).pairs[0]!;
    const raw = select([a, b], { leagueFloor: 0.05 }).pairs[0]!;
    expect(lifted.score).toBeGreaterThan(raw.score);
    expect(EVENT_LEAGUE_FLOOR).toBeGreaterThan(0.05);
  });

  it("gives someone who sat out a round priority in the next one", () => {
    const man = user({ gender: "male", preference: "women" });
    const fresh = user({ gender: "female", preference: "men" });
    const satOut = user({ gender: "female", preference: "men" });

    const without = select([man, fresh, satOut]);
    const withBump = select([man, fresh, satOut], {
      sitOutCounts: new Map([[satOut.id, 3]]),
    });

    const partner = (r: typeof without) =>
      r.pairs[0]!.userAId === man.id ? r.pairs[0]!.userBId : r.pairs[0]!.userAId;

    // Identical people, so the bump is the only thing that can move the choice.
    expect(partner(without)).toBe(fresh.id);
    expect(partner(withBump)).toBe(satOut.id);
  });

  it("caps the sit-out bump so bad luck cannot outrank compatibility", () => {
    const man = user({ gender: "male", preference: "women" });
    const near = user({ gender: "female", preference: "men" });
    const far = user({ gender: "female", preference: "men" });
    const distances = new Map([
      [pairKey(man.id, near.id), 0.05],
      [pairKey(man.id, far.id), 0.95],
      [pairKey(near.id, far.id), 0.5],
    ]);
    const { pairs } = selectRoundPairings({
      attendees: [man, near, far],
      excludedPairKeys: new Set(),
      metThisEvent: new Set(),
      distances,
      // Far more sit-outs than the cap allows to matter.
      sitOutCounts: new Map([[far.id, 99]]),
    });
    const partner = pairs[0]!.userAId === man.id ? pairs[0]!.userBId : pairs[0]!.userAId;
    expect(partner).toBe(near.id);
  });
});

describe("assignSpots", () => {
  const pairs = [
    { userAId: "a1", userBId: "b1", score: 1 },
    { userAId: "a2", userBId: "b2", score: 0.9 },
    { userAId: "a3", userBId: "b3", score: 0.8 },
  ];

  it("spreads pairs across the room round-robin", () => {
    const assigned = assignSpots(pairs, ["Bar", "Terrace"], 1);
    expect(assigned.map((a) => a.spotLabel)).toEqual(["Bar", "Terrace", "Bar"]);
  });

  it("gives every pair in a round a different code", () => {
    const codes = assignSpots(pairs, ["Bar"], 4).map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("keeps codes to two digits — they are said out loud, not read", () => {
    for (let round = 1; round <= 12; round += 1) {
      for (const { code } of assignSpots(pairs, ["Bar"], round)) {
        expect(code).toBeGreaterThanOrEqual(10);
        expect(code).toBeLessThanOrEqual(99);
      }
    }
  });

  it("still names a place when the venue has no spot list", () => {
    expect(assignSpots(pairs, [], 1).every((a) => a.spotLabel.length > 0)).toBe(true);
  });
});

describe("staticMission", () => {
  it("answers in the reader's own language", () => {
    expect(staticMission("ru", 0)).not.toBe(staticMission("en", 0));
  });

  it("falls back to English for a language it has no lines for", () => {
    expect(staticMission("xx", 0)).toBe(staticMission("en", 0));
    expect(staticMission(null, 1)).toBe(staticMission("en", 1));
  });

  it("is deterministic — a re-render must not change the mission mid-round", () => {
    expect(staticMission("uk", 7)).toBe(staticMission("uk", 7));
  });
});
