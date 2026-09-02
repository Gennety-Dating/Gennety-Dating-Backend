import { SUPPORTED_LANGUAGES, type Language } from "@gennety/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: matchFindUnique } },
}));

const sendLiveActivityStartToUser = vi.fn();
const sendLiveActivityUpdateToUser = vi.fn();
vi.mock("./push.js", () => ({ sendLiveActivityStartToUser, sendLiveActivityUpdateToUser }));

// `apns.ts` reads credentials at call time, never at import time, so an empty
// env is enough to borrow its envelope builders below — and borrowing them is
// the point: a hand-rolled copy of the envelope would measure the copy.
vi.mock("../config.js", () => ({ env: {} }));
const { buildLiveActivityPayload, buildLiveActivityStartPayload } = await import("./apns.js");

const {
  DATE_DAY_ATTRIBUTES_TYPE,
  advanceDateDayActivities,
  advanceToSpotterStage,
  advanceToVibeCheck,
  endDateDayActivities,
  endDateDayActivityAfterVibe,
  notifyPartnerArrived,
  spotterSignFor,
  startDateDayActivities,
} = await import("./date-day-activity.js");

const NOW = new Date("2026-08-10T12:00:00.000Z");
const DATE_AT = new Date("2026-08-10T17:00:00.000Z");

function matchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    agreedTime: DATE_AT,
    venueName: "Aroma Kava",
    venueAddress: "Khreshchatyk 14",
    venueGoogleMapsUri: "https://maps.google.com/?cid=1",
    userA: { id: "ua", language: "ru", firstName: "Аня" },
    userB: { id: "ub", language: "en", firstName: "Bohdan" },
    ...overrides,
  };
}

beforeEach(() => {
  matchFindUnique.mockReset();
  sendLiveActivityStartToUser.mockReset().mockResolvedValue(true);
  sendLiveActivityUpdateToUser.mockReset().mockResolvedValue(true);
});

describe("startDateDayActivities", () => {
  it("push-starts both sides with the venue and a localized alert", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await startDateDayActivities("m1", NOW);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    const [userId, type, payload] = sendLiveActivityStartToUser.mock.calls[0]!;
    expect(userId).toBe("ua");
    expect(type).toBe("date_day");
    expect(payload.attributesType).toBe(DATE_DAY_ATTRIBUTES_TYPE);
    expect(payload.attributes).toEqual({
      matchId: "m1",
      startsAt: Math.floor(DATE_AT.getTime() / 1000),
      venueName: "Aroma Kava",
      venueAddress: "Khreshchatyk 14",
      mapsUrl: "https://maps.google.com/?cid=1",
    });
    expect(payload.contentState).toEqual({ stage: "icebreakers" });
    // Stale at the date itself: that is what flips the card into its
    // "you're there" look with no push behind it.
    expect(payload.staleDate).toBe(Math.floor(DATE_AT.getTime() / 1000));

    // Each side is alerted in its OWN language, not the pair's or the caller's.
    expect(payload.alert.title).toBe("Сегодня свидание");
    expect(sendLiveActivityStartToUser.mock.calls[1]![2].alert.title).toBe("Your date is today");
  });

  it("carries the place and nothing about the person", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    await startDateDayActivities("m1", NOW);
    const payload = sendLiveActivityStartToUser.mock.calls[0]![2];
    // The lock screen is public. Pinned as an exact key set rather than an
    // absence check, so a field added later has to be argued for here first.
    expect(Object.keys(payload.attributes).sort()).toEqual([
      "mapsUrl",
      "matchId",
      "startsAt",
      "venueAddress",
      "venueName",
    ]);
    expect(Object.keys(payload.contentState)).toEqual(["stage"]);
  });

  it("does not start a card for a date that has already begun", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    await startDateDayActivities("m1", new Date(DATE_AT.getTime() + 60_000));
    expect(sendLiveActivityStartToUser).not.toHaveBeenCalled();
  });

  it("does nothing when the match has no agreed time", async () => {
    matchFindUnique.mockResolvedValue(matchRow({ agreedTime: null }));
    await startDateDayActivities("m1", NOW);
    expect(sendLiveActivityStartToUser).not.toHaveBeenCalled();
  });

  it("delivers to one side even when the other's push throws", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    sendLiveActivityStartToUser.mockRejectedValueOnce(new Error("apns down"));
    await expect(startDateDayActivities("m1", NOW)).resolves.toBeUndefined();
    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
  });
});

describe("advanceDateDayActivities", () => {
  it("updates both sides and keeps the stale date pinned to the date", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await advanceDateDayActivities("m1", "wingman");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    const [, , payload] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(payload).toEqual({
      event: "update",
      contentState: { stage: "wingman" },
      staleDate: Math.floor(DATE_AT.getTime() / 1000),
    });
  });
});

describe("endDateDayActivities", () => {
  it("ends both sides with no content state", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await endDateDayActivities("m1");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityUpdateToUser.mock.calls[0]![2]).toEqual({ event: "end" });
  });
});


describe("spotterSignFor", () => {
  it("is deterministic — the same match always gets the same sign", () => {
    // The whole mechanism is that two phones show the same thing without
    // talking to each other, so instability here would not look like a bug: it
    // would look like two people failing to find each other.
    expect(spotterSignFor("m1")).toEqual(spotterSignFor("m1"));
    expect(spotterSignFor("11111111-2222-3333-4444-555555555555")).toEqual(
      spotterSignFor("11111111-2222-3333-4444-555555555555"),
    );
  });

  it("spreads across the curated set rather than collapsing onto one sign", () => {
    const signs = new Set(
      Array.from({ length: 200 }, (_, i) => JSON.stringify(spotterSignFor(`match-${i}`))),
    );
    // 8 glyphs x 4 colours = 32 combinations. A hash that ignored most of the
    // id (or a modulo applied to the same byte twice) would still be
    // deterministic and would still pass the test above.
    expect(signs.size).toBeGreaterThan(20);
  });

  it("only ever returns a sign the client can draw", () => {
    for (let i = 0; i < 50; i++) {
      const sign = spotterSignFor(`m-${i}`);
      expect(sign.glyph).toMatch(/^[a-z0-9.]+$/);
      expect(sign.glyphHex).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe("advanceToSpotterStage", () => {
  it("gives both sides the SAME sign and each the OTHER's first name", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await advanceToSpotterStage("m1");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    const [, , toA] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    const [, , toB] = sendLiveActivityUpdateToUser.mock.calls[1]!;

    expect(toA.contentState.stage).toBe("spotter");
    expect(toA.contentState.glyph).toBe(toB.contentState.glyph);
    expect(toA.contentState.glyphHex).toBe(toB.contentState.glyphHex);
    expect(toA.contentState).toEqual({ ...spotterSignFor("m1"), stage: "spotter", partnerFirstName: "Bohdan" });
    expect(toB.contentState.partnerFirstName).toBe("Аня");
  });

  it("sends nobody their own name", async () => {
    // Getting `self` and `peer` the wrong way round would leak a person their
    // own name AND break the mechanism for both, silently.
    matchFindUnique.mockResolvedValue(matchRow());
    await advanceToSpotterStage("m1");
    const [userIdA, , toA] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(userIdA).toBe("ua");
    expect(toA.contentState.partnerFirstName).not.toBe("Аня");
  });

  it("omits the name entirely when the partner has none", async () => {
    matchFindUnique.mockResolvedValue(
      matchRow({ userB: { id: "ub", language: "en", firstName: null } }),
    );
    await advanceToSpotterStage("m1");
    const [, , toA] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    // Absent, not null: an absent key costs nothing against the 4096-byte cap.
    expect("partnerFirstName" in toA.contentState).toBe(false);
  });
});

describe("notifyPartnerArrived", () => {
  it("tells the OTHER side only, and tells it a fact rather than a position", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await notifyPartnerArrived("m1", "A");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(1);
    const [userId, , payload] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(userId).toBe("ub");
    expect(payload.contentState.partnerArrived).toBe(true);
    // The privacy boundary of the radar, restated on the card: no distance, no
    // coordinate, no ETA. Pinned as an exact key set so a field added later has
    // to be argued for here first.
    expect(Object.keys(payload.contentState).sort()).toEqual([
      "glyph",
      "glyphHex",
      "partnerArrived",
      "partnerFirstName",
      "stage",
    ]);
  });

  it("carries the same sign the stage push carried", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    await notifyPartnerArrived("m1", "B");
    const [userId, , payload] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(userId).toBe("ua");
    expect(payload.contentState.glyph).toBe(spotterSignFor("m1").glyph);
  });
});

describe("advanceToVibeCheck", () => {
  it("moves both sides and carries nothing about the partner", async () => {
    matchFindUnique.mockResolvedValue(matchRow());

    await advanceToVibeCheck("m1");

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    const [, , payload] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(payload.contentState).toEqual({ stage: "vibe_check" });
  });
});

describe("endDateDayActivityAfterVibe", () => {
  it("ends one side with the answer visible for a moment first", async () => {
    const now = new Date("2026-08-10T20:00:00.000Z");

    await endDateDayActivityAfterVibe("ua", "chemistry_great", now);

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(1);
    const [userId, type, payload] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(userId).toBe("ua");
    expect(type).toBe("date_day");
    expect(payload.event).toBe("end");
    // The server's last word matches the optimistic one the intent already
    // wrote; without it the card would blink back to three buttons for the two
    // seconds before it disappears.
    expect(payload.contentState).toEqual({ stage: "vibe_check", vibe: "chemistry_great" });
    expect(payload.dismissalDate).toBeGreaterThan(Math.floor(now.getTime() / 1000));
  });
});

/**
 * Apple's ceiling for a Live Activity payload is 4096 bytes, and crossing it is
 * NOT an error: APNs takes the request, returns 200, and the device never sees
 * the update. Nothing to notice in a log, nothing to catch in review — which is
 * why the budget is asserted here, against what the real builders emit.
 *
 * **The working ceiling is half of Apple's, and the slack is not politeness.**
 * The fattest payload is the start push, and almost all of its size comes from
 * fields nobody on this side writes: a venue name and address copied out of
 * Google Places, a Maps URI carrying a place_id, and an alert that a translator
 * can lengthen without ever opening this file.
 */
describe("APNs payload budget", () => {
  /** Half of Apple's 4096. */
  const BUDGET = 2048;

  /**
   * The worst case that can actually reach production: the longest shape Places
   * returns for a Kyiv venue, a postal address down to the entrance, a Maps URI
   * with both a place_id and a cid, and double first names. Cyrillic, not
   * English, because it costs two bytes per character on the wire.
   */
  function fatMatch(language: Language) {
    return matchRow({
      venueName: "Кав'ярня-книгарня «Літературне кафе на Хрещатику»",
      venueAddress: "вулиця Володимирська, 20/1а, під'їзд 2, поверх 3, Київ, 01001, Україна",
      venueGoogleMapsUri:
        "https://www.google.com/maps/place/?q=place_id:ChIJrTLr-GyuEmsRBfy61i59si0&cid=10281119596374313554",
      userA: { id: "ua", language, firstName: "Олександра-Вікторія" },
      userB: { id: "ub", language, firstName: "Володимир-Богдан" },
    });
  }

  function wireBytes(payload: Record<string, unknown>): number {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  it("keeps the start push under budget in every language", async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      matchFindUnique.mockResolvedValue(fatMatch(language));
      sendLiveActivityStartToUser.mockClear();

      await startDateDayActivities("m1", NOW);

      const input = sendLiveActivityStartToUser.mock.calls[0]![2];
      const bytes = wireBytes(buildLiveActivityStartPayload(input, NOW.getTime()));
      expect(bytes, `start push in ${language}`).toBeLessThan(BUDGET);
    }
  });

  it.each([
    ["wingman", () => advanceDateDayActivities("m1", "wingman")],
    ["spotter", () => advanceToSpotterStage("m1")],
    ["arrival", () => notifyPartnerArrived("m1", "B")],
    ["vibe check", () => advanceToVibeCheck("m1")],
  ] as const)("keeps the %s update under budget", async (stage, send) => {
    matchFindUnique.mockResolvedValue(fatMatch("uk"));

    await send();

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalled();
    for (const [, , input] of sendLiveActivityUpdateToUser.mock.calls) {
      const bytes = wireBytes(buildLiveActivityPayload(input, NOW.getTime()));
      expect(bytes, `${stage} update`).toBeLessThan(BUDGET);
    }
  });
});
