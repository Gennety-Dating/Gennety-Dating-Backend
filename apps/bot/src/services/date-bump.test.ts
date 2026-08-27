import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUMP_RELIABILITY_REWARD,
  BUMP_SHAKE_WINDOW_MS,
  DATE_BUMP_GRACE_HOURS,
  DATE_BUMP_OPENS_MINUTES,
} from "@gennety/shared";

const matchFindUnique = vi.fn();
const matchUpdate = vi.fn();
const bumpUpsert = vi.fn();
const bumpUpdateMany = vi.fn();
const profileUpdateMany = vi.fn();
const transaction = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique, update: matchUpdate },
    dateBumpSession: { upsert: bumpUpsert, updateMany: bumpUpdateMany, update: vi.fn() },
    profile: { updateMany: profileUpdateMany },
    $transaction: transaction,
  },
}));

const grantTickets = vi.fn();
vi.mock("./ticket-wallet.js", () => ({
  grantTickets,
  isUniqueViolation: (e: unknown) =>
    typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002",
}));

vi.mock("./openai.js", () => ({ callOpenAIText: vi.fn(async () => "") }));
vi.mock("./main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("./push.js", () => ({ sendPushToUser: vi.fn(async () => true) }));

const {
  checkBumpWindow,
  withinVenue,
  shakesAligned,
  parseNumberedLines,
  recordBump,
} = await import("./date-bump.js");

const T = new Date("2026-09-03T17:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The venue, and a point ~40 m away — inside the 100 m radius.
const VENUE = { lat: 50.4501, lng: 30.5234 };
const NEARBY = { lat: 50.45046, lng: 30.5234 };
const FAR = { lat: 50.46, lng: 30.5234 };

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

describe("the pure checks", () => {
  describe("checkBumpWindow", () => {
    it("refuses before the window opens", () => {
      expect(checkBumpWindow(T, at(-(DATE_BUMP_OPENS_MINUTES + 1) * MINUTE))).toBe(
        "too-early",
      );
    });

    it("opens exactly at T-15m", () => {
      expect(checkBumpWindow(T, at(-DATE_BUMP_OPENS_MINUTES * MINUTE))).toBe("ok");
    });

    it("still accepts well after the agreed time", () => {
      expect(checkBumpWindow(T, at(90 * MINUTE))).toBe("ok");
    });

    it("closes at the end of the grace window", () => {
      expect(checkBumpWindow(T, at(DATE_BUMP_GRACE_HOURS * HOUR))).toBe("too-late");
    });
  });

  describe("withinVenue", () => {
    it("accepts a point at the table", () => {
      expect(withinVenue(NEARBY, VENUE)).toBe(true);
    });

    it("refuses a point a block away", () => {
      expect(withinVenue(FAR, VENUE)).toBe(false);
    });
  });

  describe("shakesAligned", () => {
    it("accepts two shakes inside the window", () => {
      expect(shakesAligned(T, new Date(T.getTime() + BUMP_SHAKE_WINDOW_MS - 1))).toBe(true);
    });

    it("refuses two shakes outside it", () => {
      expect(shakesAligned(T, new Date(T.getTime() + BUMP_SHAKE_WINDOW_MS + 1))).toBe(false);
    });

    // Which phone registers first is decided by sampling and latency, not by
    // who moved first — an ordered rule would fail half the real bumps.
    it("does not care which shake came first", () => {
      const a = T;
      const b = new Date(T.getTime() + 3_000);
      expect(shakesAligned(a, b)).toBe(shakesAligned(b, a));
    });
  });

  describe("parseNumberedLines", () => {
    it("reads the format the prompt asks for", () => {
      expect(parseNumberedLines("1. one\n2. two\n3. three")).toEqual([
        "one",
        "two",
        "three",
      ]);
    });

    // Tolerant on purpose: a deck of good lines beats refusing over punctuation.
    it("survives the formats models actually return", () => {
      expect(parseNumberedLines("1) one\n- two\n• three")).toEqual([
        "one",
        "two",
        "three",
      ]);
    });

    it("drops blank lines and runaway output", () => {
      expect(parseNumberedLines(`\n\n1. fine\n2. ${"x".repeat(300)}`)).toEqual(["fine"]);
    });
  });
});

describe("recordBump", () => {
  const MATCH = {
    id: "match-1",
    status: "scheduled",
    userAId: "a",
    userBId: "b",
    agreedTime: T,
    venueLat: VENUE.lat,
    venueLng: VENUE.lng,
  };

  beforeEach(() => {
    matchFindUnique.mockReset().mockResolvedValue(MATCH);
    matchUpdate.mockReset();
    bumpUpsert.mockReset().mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: null,
    });
    bumpUpdateMany.mockReset();
    profileUpdateMany.mockReset();
    grantTickets.mockReset().mockResolvedValue(1);
    // `verifyBump` uses the INTERACTIVE form so its CAS can short-circuit, so
    // the mock has to actually run the callback rather than resolve a tuple.
    // `bumpUpdateMany`'s return value is what decides win/lose.
    bumpUpdateMany.mockResolvedValue({ count: 1 });
    transaction.mockReset().mockImplementation(async (fn: unknown) => {
      if (typeof fn !== "function") return fn;
      return (fn as (tx: unknown) => unknown)({
        dateBumpSession: { updateMany: bumpUpdateMany },
        match: { update: matchUpdate },
        profile: { updateMany: profileUpdateMany },
      });
    });
  });

  function bump(userId: string, when = T, coords = NEARBY) {
    return recordBump({ matchId: "match-1", userId, at: when, coords });
  }

  it("refuses someone who is on neither side", async () => {
    const out = await bump("stranger");
    expect(out).toMatchObject({ ok: false, reason: "not-participant" });
    expect(bumpUpsert).not.toHaveBeenCalled();
  });

  it("refuses a match that is not a scheduled date", async () => {
    matchFindUnique.mockResolvedValue({ ...MATCH, status: "negotiating" });
    expect(await bump("a")).toMatchObject({ ok: false, reason: "wrong-state" });
  });

  it("refuses a scheduled date with no venue coordinates", async () => {
    matchFindUnique.mockResolvedValue({ ...MATCH, venueLat: null, venueLng: null });
    expect(await bump("a")).toMatchObject({ ok: false, reason: "wrong-state" });
  });

  it("refuses a shake that is nowhere near the venue", async () => {
    expect(await bump("a", T, FAR)).toMatchObject({ ok: false, reason: "too-far" });
    expect(bumpUpsert).not.toHaveBeenCalled();
  });

  it("records a lone shake without verifying anything", async () => {
    const out = await bump("a");
    expect(out).toEqual({ ok: true, verified: false, justVerified: false });
    expect(transaction).not.toHaveBeenCalled();
    expect(grantTickets).not.toHaveBeenCalled();
  });

  // The whole point of reading the PEER's column: a person shaking twice is
  // retrying, not a pair.
  it("cannot verify a pair from one person shaking twice", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: T,
      userBShakeAt: null,
    });
    const out = await bump("a", new Date(T.getTime() + 1_000));
    expect(out.verified).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not verify two shakes too far apart in time", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: T,
    });
    const out = await bump("a", new Date(T.getTime() + BUMP_SHAKE_WINDOW_MS + 1));
    expect(out.verified).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("verifies the pair, credits both sides, and writes attendance", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: T,
    });

    const out = await bump("a", new Date(T.getTime() + 2_000));

    expect(out).toEqual({ ok: true, verified: true, justVerified: true });
    expect(matchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { dateAttendedA: true, dateAttendedB: true },
      }),
    );
    expect(profileUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: { in: ["a", "b"] } },
        data: { reliabilityScore: { increment: BUMP_RELIABILITY_REWARD } },
      }),
    );
    expect(grantTickets).toHaveBeenCalledTimes(2);
    expect(grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "a",
        reason: "bump_bonus",
        externalPaymentId: "bump:match-1:a",
      }),
    );
  });

  // The CAS is what makes the rewards exactly-once when both shakes land in the
  // same millisecond: the loser updates zero rows and must credit nothing.
  it("credits nothing when it loses the verification race", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: T,
    });
    bumpUpdateMany.mockResolvedValue({ count: 0 });

    const out = await bump("a", new Date(T.getTime() + 2_000));

    expect(out).toEqual({ ok: true, verified: true, justVerified: false });
    expect(grantTickets).not.toHaveBeenCalled();
  });

  // Regression: the CAS used to sit in an array `$transaction([...])`, which
  // runs every operation it is handed — so the loser's `claim.count === 0` was
  // read only AFTER these two writes had committed. `reliabilityScore` is an
  // `increment`, so a pair who shook twice together banked +100 each instead of
  // +50. Reachable without any race: both sides carry a shake timestamp from a
  // first, misaligned attempt, then shake again at the same moment.
  it("credits no reliability and writes no attendance when it loses the race", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: T,
    });
    bumpUpdateMany.mockResolvedValue({ count: 0 });

    const out = await bump("a", new Date(T.getTime() + 2_000));

    expect(out.justVerified).toBe(false);
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(matchUpdate).not.toHaveBeenCalled();
  });

  it("credits reliability exactly once when it wins the race", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: T,
    });
    bumpUpdateMany.mockResolvedValue({ count: 1 });

    const out = await bump("a", new Date(T.getTime() + 2_000));

    expect(out.justVerified).toBe(true);
    expect(profileUpdateMany).toHaveBeenCalledTimes(1);
    expect(profileUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reliabilityScore: { increment: BUMP_RELIABILITY_REWARD } },
      }),
    );
  });

  it("says an already-verified pair is verified without re-crediting", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: true,
      userAShakeAt: T,
      userBShakeAt: T,
    });

    const out = await bump("a");

    expect(out).toEqual({ ok: true, verified: true, justVerified: false });
    expect(transaction).not.toHaveBeenCalled();
    expect(grantTickets).not.toHaveBeenCalled();
  });

  // A duplicate ledger id means the ticket was already granted, which is what
  // the id is for. Anything else must not cost the pair a verification that is
  // already committed.
  it("keeps the verification when a ticket grant is a duplicate", async () => {
    bumpUpsert.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: T,
    });
    grantTickets.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));

    const out = await bump("a", new Date(T.getTime() + 2_000));

    expect(out.justVerified).toBe(true);
  });
});
