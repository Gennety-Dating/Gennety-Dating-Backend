import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindMany = vi.fn();
const matchFindFirst = vi.fn();
const profileFindUnique = vi.fn();
const bumpFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findMany: matchFindMany, findFirst: matchFindFirst },
    profile: { findUnique: profileFindUnique },
    dateBumpSession: { findUnique: bumpFindUnique },
  },
}));

vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "me";
    next();
  },
}));

const { dateStateRouter } = await import("./routes/date-state.js");
const { deadlineFor } = await import("../services/proposal-deadline.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/date", dateStateRouter);
  return app;
}

const AGREED = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

function liveMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    status: "scheduled",
    userAId: "me",
    userBId: "them",
    acceptedByA: true,
    acceptedByB: true,
    agreedTime: AGREED,
    dispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    feedbackPromptedAt: null,
    feedbackByA: null,
    feedbackByB: null,
    venueName: "Kavarnya",
    venueAddress: "Velyka Vasylkivska 1",
    venueLat: 50.44,
    venueLng: 30.52,
    venueGoogleMapsUri: "https://maps.google.com/?cid=1",
    ...overrides,
  };
}

beforeEach(() => {
  matchFindMany.mockReset().mockResolvedValue([]);
  matchFindFirst.mockReset().mockResolvedValue(null);
  profileFindUnique.mockReset().mockResolvedValue({ timeZone: "Europe/Kyiv" });
  bumpFindUnique.mockReset().mockResolvedValue(null);
});

describe("GET /v1/date/state", () => {
  it("answers for a user with no match at all", async () => {
    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("IDLE_EXPLORING");
    expect(res.body.match).toBeNull();
    expect(res.body.nextDropAt).toEqual(expect.any(String));
    expect(res.body.timeZone).toBe("Europe/Kyiv");
  });

  it("carries the locked date and its venue", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.state).toBe("DATE_SCHEDULED");
    expect(res.body.match.id).toBe("match-1");
    expect(res.body.match.venue.name).toBe("Kavarnya");
    expect(res.body.match.agreedTime).toBe(AGREED.toISOString());
  });

  // The one state whose clock is running is also the one where `agreedTime` is
  // null by definition, so without this field the canvas can name no deadline
  // at all there.
  it("carries the reply deadline on a proposed match", async () => {
    const dispatchedAt = new Date(Date.now() - 60 * 60 * 1000);
    matchFindMany.mockResolvedValue([
      liveMatch({ status: "proposed", acceptedByA: null, acceptedByB: null, agreedTime: null, dispatchedAt }),
    ]);

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.state).toBe("DROP_PENDING_DECISION");
    expect(res.body.match.agreedTime).toBeNull();
    // The same function `SerializedMatch.proposalDeadlineAt` uses — two
    // calculations of one deadline would diverge the moment the cadence moves.
    expect(res.body.match.deadlineAt).toBe(deadlineFor(dispatchedAt).toISOString());
  });

  it("carries no deadline once the pitch has been answered", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.state).toBe("DATE_SCHEDULED");
    expect(res.body.match.deadlineAt).toBeNull();
  });

  // The blind-decision invariant, asserted on the wire rather than only in the
  // pure function: the response must not carry the partner's own answer in any
  // field, however indirectly.
  it("never puts the partner's decision in the payload", async () => {
    matchFindMany.mockResolvedValue([
      liveMatch({ status: "proposed", acceptedByA: null, acceptedByB: true }),
    ]);

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.state).toBe("DROP_PENDING_DECISION");
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("acceptedBy");
  });

  it("reports only this side's own shake", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);
    bumpFindUnique.mockResolvedValue({
      isVerified: false,
      userAShakeAt: null,
      userBShakeAt: new Date(),
    });

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.match.bump).toEqual({ mine: false, verified: false });
  });

  // The side that shook FIRST gets a 200 with no deck from /bump, so without
  // this field it would have the topics only as notification text.
  it("carries this side's own deck once the pair is verified", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);
    bumpFindUnique.mockResolvedValue({
      isVerified: true,
      userAShakeAt: new Date(),
      userBShakeAt: new Date(),
      icebreakerDeck: { topicsForA: ["Mine one", "Mine two"], topicsForB: ["Theirs"] },
    });

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.match.deck).toEqual(["Mine one", "Mine two"]);
    // Per-side and in each side's own language: the partner's half is not the
    // caller's to read, and no client has a use for it.
    expect(JSON.stringify(res.body)).not.toContain("Theirs");
  });

  it("gives side B its own half", async () => {
    matchFindMany.mockResolvedValue([liveMatch({ userAId: "them", userBId: "me" })]);
    bumpFindUnique.mockResolvedValue({
      isVerified: true,
      userAShakeAt: new Date(),
      userBShakeAt: new Date(),
      icebreakerDeck: { topicsForA: ["Theirs"], topicsForB: ["Mine"] },
    });

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.match.deck).toEqual(["Mine"]);
  });

  // Before verification there is nothing to say, and an unverified deck would
  // be a claim that the pair is at the table.
  it("withholds the deck until the bump verifies", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);
    bumpFindUnique.mockResolvedValue({
      isVerified: false,
      userAShakeAt: new Date(),
      userBShakeAt: null,
      icebreakerDeck: { topicsForA: ["Mine"], topicsForB: ["Theirs"] },
    });

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.match.deck).toEqual([]);
  });

  // Generation is best-effort and its own fallback can still fail; a verified
  // pair with no stored deck must answer with an empty list, not a crash.
  it("answers an empty deck when generation left nothing behind", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);
    bumpFindUnique.mockResolvedValue({
      isVerified: true,
      userAShakeAt: new Date(),
      userBShakeAt: new Date(),
      icebreakerDeck: null,
    });

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.status).toBe(200);
    expect(res.body.match.deck).toEqual([]);
  });

  // A completed match is outside ACTIVE_MATCH_STATUSES, so without the second
  // query the canvas could never discover that feedback is owed — the exact
  // hole §Phase 4 had to close on the app rail.
  it("finds a closed match that still owes feedback", async () => {
    matchFindMany.mockResolvedValue([]);
    matchFindFirst.mockResolvedValue(
      liveMatch({
        status: "completed",
        feedbackPromptedAt: new Date(),
        agreedTime: new Date(Date.now() - 25 * 60 * 60 * 1000),
      }),
    );

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.state).toBe("POST_DATE_FEEDBACK");
    expect(matchFindFirst).toHaveBeenCalledTimes(1);
  });

  it("does not look for a closed match while a live one exists", async () => {
    matchFindMany.mockResolvedValue([liveMatch()]);

    await request(buildApp()).get("/v1/date/state");

    expect(matchFindFirst).not.toHaveBeenCalled();
  });

  // Corrupt data, not a third participant: guessing a side here is the mistake
  // startPeerWaitShimmer made once already.
  it("treats a row belonging to neither side as no match", async () => {
    matchFindMany.mockResolvedValue([
      liveMatch({ userAId: "someone", userBId: "else" }),
    ]);

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.body.state).toBe("IDLE_EXPLORING");
    expect(res.body.match).toBeNull();
    expect(bumpFindUnique).not.toHaveBeenCalled();
  });

  it("survives a profile with no city zone", async () => {
    profileFindUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get("/v1/date/state");

    expect(res.status).toBe(200);
    expect(res.body.timeZone).toBeNull();
  });
});
