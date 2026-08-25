import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
const profileFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    profile: { findUnique: profileFindUnique },
  },
}));

let caller = "me";
vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = caller;
    next();
  },
}));

const { dateRadarRouter } = await import("./routes/date-radar.js");
const { resetRadarPresenceForTests, recordPresence } = await import(
  "../services/date-radar.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/dates", dateRadarRouter);
  return app;
}

const VENUE = { lat: 50.4501, lng: 30.5234 };
/** ~40 m from the venue. */
const AT_DOOR = { lat: 50.45046, lng: 30.5234 };
/** ~1.1 km from the venue. */
const NEARBY = { lat: 50.46, lng: 30.5234 };

/** Inside the radar window: twenty minutes before the date. */
const soon = () => new Date(Date.now() + 20 * 60_000);

function scheduled(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "scheduled",
    userAId: "me",
    userBId: "them",
    agreedTime: soon(),
    venueLat: VENUE.lat,
    venueLng: VENUE.lng,
    ...overrides,
  };
}

const ID = "11111111-1111-4111-8111-111111111111";

function ping(body: Record<string, unknown>) {
  return request(buildApp()).post(`/v1/dates/${ID}/proximity`).send(body);
}

describe("POST /v1/dates/:matchId/proximity", () => {
  beforeEach(() => {
    caller = "me";
    resetRadarPresenceForTests();
    matchFindUnique.mockReset().mockResolvedValue(scheduled());
    profileFindUnique.mockReset().mockResolvedValue({ timeZone: "Europe/Kyiv" });
  });

  it("rejects a non-UUID id before touching the database", async () => {
    const res = await request(buildApp()).post("/v1/dates/nope/proximity").send(NEARBY);
    expect(res.status).toBe(400);
    expect(matchFindUnique).not.toHaveBeenCalled();
  });

  it("requires coordinates", async () => {
    expect((await ping({})).status).toBe(400);
    expect((await ping({ lat: 999, lng: 30 })).status).toBe(400);
  });

  // 404 rather than 403, so the endpoint cannot be used to probe which match
  // ids exist. Same rule as the Bump.
  it("answers 404 for someone on neither side", async () => {
    caller = "stranger";
    const res = await ping(NEARBY);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "not-participant" });
  });

  it("refuses a match that is not a scheduled date", async () => {
    matchFindUnique.mockResolvedValue(scheduled({ status: "negotiating" }));
    expect((await ping(NEARBY)).status).toBe(409);
  });

  it("refuses a scheduled date with no venue coordinates", async () => {
    matchFindUnique.mockResolvedValue(scheduled({ venueLat: null, venueLng: null }));
    expect((await ping(NEARBY)).status).toBe(409);
  });

  it("refuses a ping before the radar opens", async () => {
    matchFindUnique.mockResolvedValue(
      scheduled({ agreedTime: new Date(Date.now() + 3 * 60 * 60_000) }),
    );
    const res = await ping(NEARBY);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "too-early" });
  });

  it("refuses a ping after the date has started", async () => {
    matchFindUnique.mockResolvedValue(
      scheduled({ agreedTime: new Date(Date.now() - 60_000) }),
    );
    const res = await ping(NEARBY);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "too-late" });
  });

  it("reports the caller's own arrival and says nothing about a silent partner", async () => {
    const res = await ping(AT_DOOR);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, arrived: true, peer: "unknown" });
  });

  it("hands back the partner's masked status", async () => {
    recordPresence(ID, "B", { arrived: false, etaAt: new Date(Date.now() + 6 * 60_000) }, new Date());
    const res = await ping(NEARBY);
    expect(res.body.peer).toBe("en_route");
    expect(res.body.peerEtaLocal).toMatch(/^\d{2}:\d{2}$/);
    expect(res.body.arrived).toBe(false);
  });

  it("celebrates only when both sides are at the venue", async () => {
    recordPresence(ID, "B", { arrived: true }, new Date());
    const res = await ping(AT_DOOR);
    expect(res.body).toMatchObject({ peer: "arrived", bothArrived: true });
  });

  // The whole feature's privacy boundary, asserted on the wire rather than on
  // a helper: what crosses between two people must carry no position.
  it("never puts a position, a distance or an address on the wire", async () => {
    recordPresence(ID, "B", { arrived: false, etaAt: new Date(Date.now() + 6 * 60_000) }, new Date());
    const res = await ping(NEARBY);
    const wire = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ["lat", "lng", "distance", "address", "coord", "venue"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("ignores a travel mode it does not know rather than refusing the ping", async () => {
    const res = await ping({ ...NEARBY, mode: "teleport" });
    expect(res.status).toBe(200);
  });
});
