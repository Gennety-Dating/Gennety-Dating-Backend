/**
 * Party Mode's attendee surface (LAUNCH_EVENTS §9.1, §9.3).
 *
 * Three properties carry this file, and each is invisible from a happy path:
 * check-in is the gate (nobody outside the room gets a pairing), a single
 * "we crossed paths" tap reveals nothing about the other side, and the
 * partner's mission line is never sent to the wrong person.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const envMock = { EVENTS_FEATURE_ENABLED: true, EVENT_QR_SECRET: "a".repeat(64) };
vi.mock("../config.js", () => ({ env: envMock }));

const VIEWER = "11111111-1111-4111-8111-111111111111";
const PARTNER = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const PAIRING_ID = "44444444-4444-4444-8444-444444444444";

const ticketFindUnique = vi.fn();
const ticketUpdateMany = vi.fn();
const pairingFindFirst = vi.fn();
const pairingFindUnique = vi.fn();
const pairingUpdateMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    eventTicket: {
      findUnique: (...a: unknown[]) => ticketFindUnique(...a),
      updateMany: (...a: unknown[]) => ticketUpdateMany(...a),
      findMany: vi.fn(),
    },
    eventRoundPairing: {
      findFirst: (...a: unknown[]) => pairingFindFirst(...a),
      findUnique: (...a: unknown[]) => pairingFindUnique(...a),
      updateMany: (...a: unknown[]) => pairingUpdateMany(...a),
    },
    profile: { findUnique: vi.fn() },
    event: { findMany: vi.fn(), findFirst: vi.fn() },
    eventTicketTier: { findMany: vi.fn() },
    waitlistApplication: { findMany: vi.fn(), findFirst: vi.fn() },
    $transaction: (fn: (t: unknown) => unknown) => fn({}),
  },
}));

vi.mock("./rate-limit.js", () => ({
  canvasLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  gatekeeperLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// The dual-rail middleware has its own tests; here it only has to put a user
// on the request so the routes below can be exercised.
vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = VIEWER;
    next();
  },
}));

const { eventsPublicRouter } = await import("./routes/events.js");

const app = express();
app.use(express.json());
app.use("/v1/events", eventsPublicRouter);

/** A round that is open right now, with the viewer as side A. */
function openPairing(overrides: Record<string, unknown> = {}) {
  return {
    id: PAIRING_ID,
    userAId: VIEWER,
    missionA: "Find out which of you has the worse taste in music.",
    missionB: "Get them to explain their camera roll.",
    metConfirmedA: null,
    metConfirmedB: null,
    spotLabel: "Bar counter",
    code: 42,
    round: { index: 2, closesAt: new Date("2026-09-12T19:20:00.000Z") },
    userA: { firstName: "Ева" },
    userB: { firstName: "Артём" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.EVENTS_FEATURE_ENABLED = true;
  ticketFindUnique.mockResolvedValue({ status: "checked_in", pausedAt: null });
  pairingFindFirst.mockResolvedValue(null);
  pairingUpdateMany.mockResolvedValue({ count: 1 });
});

describe("GET /:id/live", () => {
  it("404s while the feature is off, without reading a ticket", async () => {
    envMock.EVENTS_FEATURE_ENABLED = false;
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.status).toBe(404);
    expect(ticketFindUnique).not.toHaveBeenCalled();
  });

  // Check-in IS the geofence (§9.1): a staff-scanned QR at the door beats any
  // coordinate the client could report, and costs no permission prompt.
  it("gives no pairing to someone who has not been scanned in", async () => {
    ticketFindUnique.mockResolvedValue({ status: "claimed", pausedAt: null });
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkedIn: false, paused: false, pairing: null });
    // And it does not go looking for one either.
    expect(pairingFindFirst).not.toHaveBeenCalled();
  });

  it("gives no pairing to somebody with no ticket at all", async () => {
    ticketFindUnique.mockResolvedValue(null);
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.body.checkedIn).toBe(false);
  });

  it("carries the spot, the code and the round's own deadline", async () => {
    pairingFindFirst.mockResolvedValue(openPairing());
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.status).toBe(200);
    expect(res.body.pairing).toMatchObject({
      pairingId: PAIRING_ID,
      roundIndex: 2,
      spotLabel: "Bar counter",
      code: 42,
      partnerFirstName: "Артём",
      closesAt: "2026-09-12T19:20:00.000Z",
    });
  });

  it("sends this side's mission and never the partner's", async () => {
    pairingFindFirst.mockResolvedValue(openPairing());
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.body.pairing.mission).toBe(
      "Find out which of you has the worse taste in music.",
    );
    expect(JSON.stringify(res.body)).not.toContain("camera roll");
  });

  it("names the OTHER person when the viewer is side B", async () => {
    pairingFindFirst.mockResolvedValue(openPairing({ userAId: PARTNER }));
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.body.pairing.partnerFirstName).toBe("Ева");
    expect(res.body.pairing.mission).toBe("Get them to explain their camera roll.");
  });

  // The blind rule: one confirmation must look identical to none from the
  // other side, or the first tapper learns the answer before giving their own.
  it("does not reveal that the partner has already confirmed", async () => {
    pairingFindFirst.mockResolvedValue(
      openPairing({ metConfirmedB: new Date("2026-09-12T19:05:00.000Z") }),
    );
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.body.pairing.iConfirmed).toBe(false);
    expect(res.body.pairing.mutual).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("19:05");
  });

  it("celebrates only once BOTH have confirmed", async () => {
    pairingFindFirst.mockResolvedValue(
      openPairing({ metConfirmedA: new Date(), metConfirmedB: new Date() }),
    );
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.body.pairing).toMatchObject({ iConfirmed: true, mutual: true });
  });

  it("reports sitting out", async () => {
    ticketFindUnique.mockResolvedValue({ status: "checked_in", pausedAt: new Date() });
    const res = await request(app).get(`/v1/events/${EVENT_ID}/live`);
    expect(res.body.paused).toBe(true);
  });

  it("only ever looks for a round that is still open", async () => {
    await request(app).get(`/v1/events/${EVENT_ID}/live`);
    const where = pairingFindFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(where.where.round).toMatchObject({ status: "open" });
  });
});

describe("POST /:id/pairings/:pairingId/met", () => {
  it("confirms this side and reports no mutual yet", async () => {
    pairingFindUnique
      .mockResolvedValueOnce({ id: PAIRING_ID, userAId: VIEWER, userBId: PARTNER })
      .mockResolvedValueOnce({ metConfirmedA: new Date(), metConfirmedB: null });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mutual: false });
  });

  it("reports the mutual once the other side is in", async () => {
    pairingFindUnique
      .mockResolvedValueOnce({ id: PAIRING_ID, userAId: VIEWER, userBId: PARTNER })
      .mockResolvedValueOnce({ metConfirmedA: new Date(), metConfirmedB: new Date() });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`);
    expect(res.body).toEqual({ ok: true, mutual: true });
  });

  // A double tap must be the same timestamp, not a second one.
  it("writes only into an unconfirmed side", async () => {
    pairingFindUnique
      .mockResolvedValueOnce({ id: PAIRING_ID, userAId: VIEWER, userBId: PARTNER })
      .mockResolvedValueOnce({ metConfirmedA: new Date(), metConfirmedB: null });
    await request(app).post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`);
    expect(pairingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAIRING_ID, metConfirmedA: null } }),
    );
  });

  it("writes into side B when the viewer is side B", async () => {
    pairingFindUnique
      .mockResolvedValueOnce({ id: PAIRING_ID, userAId: PARTNER, userBId: VIEWER })
      .mockResolvedValueOnce({ metConfirmedA: null, metConfirmedB: new Date() });
    await request(app).post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`);
    expect(pairingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAIRING_ID, metConfirmedB: null } }),
    );
  });

  // "Not yours" and "does not exist" answer identically, so the route cannot
  // be walked to discover which pairing ids are real.
  it("answers 404 identically for a stranger's pairing and an unknown one", async () => {
    pairingFindUnique.mockResolvedValueOnce({
      id: PAIRING_ID,
      userAId: PARTNER,
      userBId: "99999999-9999-4999-8999-999999999999",
    });
    const stranger = await request(app).post(
      `/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`,
    );
    pairingFindUnique.mockResolvedValueOnce(null);
    const unknown = await request(app).post(
      `/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`,
    );
    expect(stranger.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(stranger.body).toEqual(unknown.body);
  });

  it("never writes for a non-participant", async () => {
    pairingFindUnique.mockResolvedValueOnce({
      id: PAIRING_ID,
      userAId: PARTNER,
      userBId: "99999999-9999-4999-8999-999999999999",
    });
    await request(app).post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/met`);
    expect(pairingUpdateMany).not.toHaveBeenCalled();
  });
});

describe("POST /:id/pause", () => {
  beforeEach(() => ticketUpdateMany.mockResolvedValue({ count: 1 }));

  it("sits the attendee out", async () => {
    const res = await request(app)
      .post(`/v1/events/${EVENT_ID}/pause`)
      .send({ paused: true });
    expect(res.body).toEqual({ ok: true, paused: true });
    expect(ticketUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pausedAt: expect.any(Date) } }),
    );
  });

  it("brings them back", async () => {
    const res = await request(app)
      .post(`/v1/events/${EVENT_ID}/pause`)
      .send({ paused: false });
    expect(res.body).toEqual({ ok: true, paused: false });
    expect(ticketUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pausedAt: null } }),
    );
  });

  // A bodyless tap means "I need a break" — the only reason to press it.
  it("treats a missing body as sitting out", async () => {
    const res = await request(app).post(`/v1/events/${EVENT_ID}/pause`);
    expect(res.body.paused).toBe(true);
  });

  it("404s for someone with no ticket to this event", async () => {
    ticketUpdateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/pause`);
    expect(res.status).toBe(404);
  });
});
