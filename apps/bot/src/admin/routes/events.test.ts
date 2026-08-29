import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * `/admin/events` — the launch-event moderation hub.
 *
 * Route-level only: the feature gate, validation branching, the lifecycle CAS,
 * and the two guards that protect a physical room (capacity, and the refusal
 * to hand-approve an unverified applicant). The tiering arithmetic itself is
 * covered without Express or a database in `services/event-admission.test.ts`.
 */

// Mutable so a single test can flip the master flag and assert the routes
// disappear — the property that makes "ships dark" checkable rather than
// asserted. Every other test runs with it on.
const envMock = vi.hoisted(() => ({
  EVENTS_FEATURE_ENABLED: true,
}));

vi.mock("../../config.js", () => ({ env: envMock }));

const EVENT = vi.hoisted(() => ({
  id: "00000000-0000-0000-0000-0000000000e1",
  cityKey: "ua:kyiv",
  kind: "launch",
  status: "draft",
  title: "Kyiv launch",
  curatedVenueId: null,
  venueName: "Bar",
  venueAddress: "Khreshchatyk 1",
  venueLat: 50.45,
  venueLng: 30.52,
  startsAt: new Date("2026-09-10T18:00:00Z"),
  endsAt: new Date("2026-09-10T23:00:00Z"),
  timeZone: "Europe/Kyiv",
  capacity: 50,
  admissionPolicy: "manual",
  autoApplyOnVerification: false,
  targetMaleShare: 0.5,
  ratioTolerance: 0.08,
  autoApproveScore: null,
  reviewFloorScore: null,
  admissionOpensAt: null,
  admissionClosesAt: null,
  createdAt: new Date("2026-08-29T00:00:00Z"),
  updatedAt: new Date("2026-08-29T00:00:00Z"),
}));

const db = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  eventFindUnique: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
  eventUpdateMany: vi.fn(),
  appFindMany: vi.fn(),
  appFindUnique: vi.fn(),
  appUpdateMany: vi.fn(),
  appGroupBy: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    event: {
      findMany: (...a: unknown[]) => db.eventFindMany(...a),
      findUnique: (...a: unknown[]) => db.eventFindUnique(...a),
      create: (...a: unknown[]) => db.eventCreate(...a),
      update: (...a: unknown[]) => db.eventUpdate(...a),
      updateMany: (...a: unknown[]) => db.eventUpdateMany(...a),
    },
    waitlistApplication: {
      findMany: (...a: unknown[]) => db.appFindMany(...a),
      findUnique: (...a: unknown[]) => db.appFindUnique(...a),
      updateMany: (...a: unknown[]) => db.appUpdateMany(...a),
      groupBy: (...a: unknown[]) => db.appGroupBy(...a),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        waitlistApplication: {
          findUnique: (...a: unknown[]) => db.appFindUnique(...a),
          updateMany: (...a: unknown[]) => db.appUpdateMany(...a),
          groupBy: (...a: unknown[]) => db.appGroupBy(...a),
        },
      }),
  },
}));

vi.mock("../utils/user-health-source.js", () => ({
  classifyAllUsers: vi.fn().mockResolvedValue({
    users: [{ id: "test-user", verdict: { classification: "test" } }],
    scanned: 1,
    truncated: false,
  }),
}));

const { eventsRouter } = await import("./events.js");
const express = (await import("express")).default;

const app = express();
app.use(express.json());
app.use(eventsRouter);

const validEvent = {
  cityKey: "ua:kyiv",
  title: "Kyiv launch",
  venueName: "Bar",
  venueAddress: "Khreshchatyk 1",
  venueLat: 50.45,
  venueLng: 30.52,
  startsAt: "2026-09-10T18:00:00Z",
  endsAt: "2026-09-10T23:00:00Z",
  capacity: 50,
};

beforeEach(() => {
  vi.clearAllMocks();
  envMock.EVENTS_FEATURE_ENABLED = true;
  db.eventFindMany.mockResolvedValue([EVENT]);
  db.eventFindUnique.mockResolvedValue(EVENT);
  db.eventCreate.mockResolvedValue(EVENT);
  db.eventUpdate.mockResolvedValue(EVENT);
  db.eventUpdateMany.mockResolvedValue({ count: 1 });
  db.appFindMany.mockResolvedValue([]);
  db.appGroupBy.mockResolvedValue([]);
  db.appUpdateMany.mockResolvedValue({ count: 1 });
});

describe("feature gate", () => {
  it("answers 404 on every route while the flag is off", async () => {
    envMock.EVENTS_FEATURE_ENABLED = false;
    for (const call of [
      request(app).get("/admin/events"),
      request(app).post("/admin/events").send(validEvent),
      request(app).get(`/admin/events/${EVENT.id}/pipeline`),
    ]) {
      const res = await call;
      expect(res.status).toBe(404);
    }
    expect(db.eventFindMany).not.toHaveBeenCalled();
    expect(db.eventCreate).not.toHaveBeenCalled();
  });
});

describe("POST /admin/events", () => {
  it("creates an event and derives the market's time zone", async () => {
    const res = await request(app).post("/admin/events").send(validEvent);
    expect(res.status).toBe(200);
    expect(db.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cityKey: "ua:kyiv", timeZone: "Europe/Kyiv" }),
      }),
    );
  });

  it("defaults to the manual policy — nothing auto-admits unless asked", async () => {
    await request(app).post("/admin/events").send(validEvent);
    expect(db.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ admissionPolicy: "manual" }) }),
    );
  });

  it("refuses a city the product has not launched", async () => {
    const res = await request(app)
      .post("/admin/events")
      .send({ ...validEvent, cityKey: "de:berlin" });
    expect(res.status).toBe(400);
    expect(db.eventCreate).not.toHaveBeenCalled();
  });

  it("refuses an end before a start", async () => {
    const res = await request(app)
      .post("/admin/events")
      .send({ ...validEvent, endsAt: "2026-09-10T17:00:00Z" });
    expect(res.status).toBe(400);
  });

  it("refuses a review floor above the auto-approve bar", async () => {
    // An unreachable pending_review band is a misconfiguration that presents
    // as an empty moderation queue — refuse it at the door.
    const res = await request(app)
      .post("/admin/events")
      .send({ ...validEvent, admissionPolicy: "scored", autoApproveScore: 60, reviewFloorScore: 80 });
    expect(res.status).toBe(400);
  });

  it("refuses an unknown admission policy", async () => {
    const res = await request(app)
      .post("/admin/events")
      .send({ ...validEvent, admissionPolicy: "vibes" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /admin/events/:id — lifecycle", () => {
  it("refuses an illegal transition by name", async () => {
    db.eventFindUnique.mockResolvedValue({ ...EVENT, status: "concluded" });
    const res = await request(app).patch(`/admin/events/${EVENT.id}`).send({ status: "live" });
    expect(res.status).toBe(409);
    expect(db.eventUpdateMany).not.toHaveBeenCalled();
  });

  it("advances a legal transition with a compare-and-set on the current status", async () => {
    db.eventFindUnique.mockResolvedValue({ ...EVENT, status: "draft" });
    const res = await request(app).patch(`/admin/events/${EVENT.id}`).send({ status: "upcoming" });
    expect(res.status).toBe(200);
    expect(db.eventUpdateMany).toHaveBeenCalledWith({
      where: { id: EVENT.id, status: "draft" },
      data: { status: "upcoming" },
    });
  });

  it("reports a lost race rather than clobbering it", async () => {
    db.eventFindUnique.mockResolvedValue({ ...EVENT, status: "draft" });
    db.eventUpdateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).patch(`/admin/events/${EVENT.id}`).send({ status: "upcoming" });
    expect(res.status).toBe(409);
  });

  it("rejects a non-UUID id", async () => {
    const res = await request(app).patch("/admin/events/not-a-uuid").send({ title: "x" });
    expect(res.status).toBe(400);
  });
});

describe("POST .../decide", () => {
  const appId = "00000000-0000-0000-0000-0000000000a1";
  const baseApp = {
    id: appId,
    eventId: EVENT.id,
    tier: "pending_review",
    scoreAtTiering: 80,
    genderAtTiering: "male",
    user: { gender: "male", profile: { eloScore: 700, eloSeededAt: new Date(), eloSeedDetails: null } },
    event: { capacity: 50 },
  };

  it("approves and stamps the actor", async () => {
    db.appFindUnique.mockResolvedValue(baseApp);
    db.appGroupBy.mockResolvedValue([{ genderAtTiering: "male", _count: { _all: 10 } }]);
    const res = await request(app)
      .post(`/admin/events/${EVENT.id}/applications/${appId}/decide`)
      .send({ action: "approve", actor: "gleb" });
    expect(res.status).toBe(200);
    expect(db.appUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: appId, tier: "pending_review" },
        data: expect.objectContaining({ tier: "approved", decidedBy: "gleb" }),
      }),
    );
  });

  it("refuses to approve past capacity", async () => {
    db.appFindUnique.mockResolvedValue(baseApp);
    db.appGroupBy.mockResolvedValue([{ genderAtTiering: "male", _count: { _all: 50 } }]);
    const res = await request(app)
      .post(`/admin/events/${EVENT.id}/applications/${appId}/decide`)
      .send({ action: "approve" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("at_capacity");
    expect(db.appUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to hand-approve an unverified applicant", async () => {
    // Mandatory liveness is a product invariant; an admin button is not an
    // exception to it.
    db.appFindUnique.mockResolvedValue({ ...baseApp, tier: "screening" });
    const res = await request(app)
      .post(`/admin/events/${EVENT.id}/applications/${appId}/decide`)
      .send({ action: "approve" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("not_verified");
    expect(db.appUpdateMany).not.toHaveBeenCalled();
  });

  it("still allows waitlisting a screening applicant (no capacity implication)", async () => {
    db.appFindUnique.mockResolvedValue({ ...baseApp, tier: "screening" });
    const res = await request(app)
      .post(`/admin/events/${EVENT.id}/applications/${appId}/decide`)
      .send({ action: "waitlist" });
    expect(res.status).toBe(200);
  });

  it("404s an application that belongs to another event", async () => {
    db.appFindUnique.mockResolvedValue({ ...baseApp, eventId: "00000000-0000-0000-0000-0000000000ff" });
    const res = await request(app)
      .post(`/admin/events/${EVENT.id}/applications/${appId}/decide`)
      .send({ action: "approve" });
    expect(res.status).toBe(404);
  });

  it("rejects an unknown action", async () => {
    const res = await request(app)
      .post(`/admin/events/${EVENT.id}/applications/${appId}/decide`)
      .send({ action: "admit-everyone" });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/events/:id/pipeline", () => {
  it("excludes test accounts from the denominator and says how many", async () => {
    db.appFindMany.mockResolvedValue([
      { userId: "real-1", tier: "approved", scoreAtTiering: 80, genderAtTiering: "male", decidedBy: "gleb" },
      { userId: "real-2", tier: "pending_review", scoreAtTiering: 40, genderAtTiering: "female", decidedBy: null },
      { userId: "test-user", tier: "approved", scoreAtTiering: 90, genderAtTiering: "male", decidedBy: "auto" },
    ]);
    const res = await request(app).get(`/admin/events/${EVENT.id}/pipeline`);
    expect(res.status).toBe(200);
    expect(res.body.applicants.total).toBe(2);
    expect(res.body.applicants.excludedTestUsers).toBe(1);
    expect(res.body.admitted.total).toBe(1);
  });

  it("reports null rather than 0 for a share with no admitted set", async () => {
    db.appFindMany.mockResolvedValue([]);
    const res = await request(app).get(`/admin/events/${EVENT.id}/pipeline`);
    expect(res.body.admitted.maleShare).toBeNull();
    expect(res.body.scores.avg).toBeNull();
  });

  it("buckets scores into deciles rather than listing them per user", async () => {
    db.appFindMany.mockResolvedValue([
      { userId: "a", tier: "approved", scoreAtTiering: 5, genderAtTiering: "male", decidedBy: "auto" },
      { userId: "b", tier: "approved", scoreAtTiering: 95, genderAtTiering: "female", decidedBy: "auto" },
      { userId: "c", tier: "approved", scoreAtTiering: 100, genderAtTiering: "female", decidedBy: "auto" },
    ]);
    const res = await request(app).get(`/admin/events/${EVENT.id}/pipeline`);
    expect(res.body.scores.deciles[0]).toBe(1);
    // 100 clamps into the last bucket rather than overflowing into an 11th.
    expect(res.body.scores.deciles[9]).toBe(2);
    expect(res.body.scores.deciles).toHaveLength(10);
  });
});
