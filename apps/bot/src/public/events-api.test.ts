/**
 * The attendee surface, `/v1/events/*` (LAUNCH_EVENTS_PRODUCT_SPEC.md §6).
 *
 * Two things here are product invariants rather than handler details, and both
 * fail silently: what the applicant is allowed to LEARN about their own
 * decision (never a score, never a threshold, never the cohort's ratio), and
 * that the feature is genuinely unreachable while its flag is off rather than
 * merely quiet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const envMock = { EVENTS_FEATURE_ENABLED: true, EVENT_QR_SECRET: "a".repeat(64) };
vi.mock("../config.js", () => ({ env: envMock }));

const profileFindUnique = vi.fn();
const eventFindMany = vi.fn();
const eventFindUnique = vi.fn();
const applicationUpsert = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    profile: { findUnique: (...a: unknown[]) => profileFindUnique(...a) },
    event: {
      findMany: (...a: unknown[]) => eventFindMany(...a),
      findUnique: (...a: unknown[]) => eventFindUnique(...a),
    },
    waitlistApplication: { upsert: (...a: unknown[]) => applicationUpsert(...a) },
  },
}));

const claimEventTicket = vi.fn();
const mintTicketQr = vi.fn();
const rotateTicketNonce = vi.fn();
vi.mock("../services/event-ticket.js", () => ({
  claimEventTicket: (...a: unknown[]) => claimEventTicket(...a),
  mintTicketQr: (...a: unknown[]) => mintTicketQr(...a),
  rotateTicketNonce: (...a: unknown[]) => rotateTicketNonce(...a),
}));

const tierOneApplication = vi.fn();
vi.mock("../services/event-admission.js", () => ({
  ADMITTED_TIERS: ["auto_approved", "approved"] as const,
  tierOneApplication: (...a: unknown[]) => tierOneApplication(...a),
}));

// The dual-rail auth is covered by canvas-auth.test.ts; here it only has to put
// a caller on the request so the handlers under test are reachable.
const USER_ID = "44444444-4444-4444-8444-444444444444";
vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { userId?: string }).userId = USER_ID;
    next();
  },
}));
vi.mock("./rate-limit.js", () => ({
  canvasLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { eventsPublicRouter } = await import("./routes/events.js");

const app = express();
app.use(express.json());
app.use("/v1/events", eventsPublicRouter);

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TIER_ID = "22222222-2222-4222-8222-222222222222";

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Launch night",
    kind: "launch",
    status: "upcoming",
    venueName: "Aroma Kava",
    venueAddress: "Khreshchatyk 14",
    startsAt: new Date("2026-09-12T18:00:00.000Z"),
    endsAt: new Date("2026-09-12T23:00:00.000Z"),
    timeZone: "Europe/Kyiv",
    applications: [],
    tickets: [],
    tiers: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.EVENTS_FEATURE_ENABLED = true;
  envMock.EVENT_QR_SECRET = "a".repeat(64);
  profileFindUnique.mockResolvedValue({ homeCityKey: "ua:kyiv" });
  eventFindMany.mockResolvedValue([]);
});

describe("the feature flag", () => {
  // Off must mean unreachable, not quiet: a 404 says the surface is not part of
  // the API at all, and nothing may touch the database on the way to saying so.
  it.each([
    ["get", "/v1/events"],
    ["post", `/v1/events/${EVENT_ID}/apply`],
    ["post", `/v1/events/${EVENT_ID}/ticket`],
    ["get", `/v1/events/${EVENT_ID}/ticket/qr`],
    ["post", `/v1/events/${EVENT_ID}/ticket/rotate`],
  ])("answers 404 for %s %s while off", async (method, path) => {
    envMock.EVENTS_FEATURE_ENABLED = false;
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ](path).send({});
    expect(res.status).toBe(404);
    expect(eventFindMany).not.toHaveBeenCalled();
    expect(claimEventTicket).not.toHaveBeenCalled();
  });
});

describe("GET /v1/events", () => {
  it("lists the caller's own market and their state on each event", async () => {
    eventFindMany.mockResolvedValue([
      eventRow({
        applications: [{ tier: "approved" }],
        tickets: [{ id: "t1", status: "issued" }],
        tiers: [
          {
            id: TIER_ID,
            kind: "free_rsvp",
            title: "General",
            capacity: 50,
            claimed: 47,
            requiresAdmission: true,
          },
        ],
      }),
    ]);

    const res = await request(app).get("/v1/events");

    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({
      admission: "admitted",
      hasTicket: true,
      // The city's wall clock rides along, because the reader's device is the
      // wrong one for a traveller.
      timeZone: "Europe/Kyiv",
      tiers: [{ id: TIER_ID, spotsLeft: 3 }],
    });
    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ cityKey: "ua:kyiv" }) }),
    );
  });

  // The exact fill of a party is the founder's number. A remaining COUNT is the
  // only part of it an attendee can act on.
  it("exposes a remaining count, never the raw claimed/capacity pair", async () => {
    eventFindMany.mockResolvedValue([
      eventRow({
        tiers: [
          {
            id: TIER_ID,
            kind: "free_rsvp",
            title: "General",
            capacity: 50,
            claimed: 47,
            requiresAdmission: true,
          },
        ],
      }),
    ]);
    const res = await request(app).get("/v1/events");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("capacity");
    expect(body).not.toContain("claimed");
  });

  // Offering it self-serve would be a "skip the queue" button.
  it("never offers the vip guestlist", async () => {
    eventFindMany.mockResolvedValue([
      eventRow({
        tiers: [
          {
            id: "guest",
            kind: "vip_guestlist",
            title: "Guestlist",
            capacity: 20,
            claimed: 0,
            requiresAdmission: false,
          },
          {
            id: TIER_ID,
            kind: "free_rsvp",
            title: "General",
            capacity: 50,
            claimed: 0,
            requiresAdmission: true,
          },
        ],
      }),
    ]);
    const res = await request(app).get("/v1/events");
    expect(res.body.events[0].tiers).toEqual([
      { id: TIER_ID, title: "General", spotsLeft: 50 },
    ]);
  });

  // An open-admission tier is claimable and must still be OFFERED. Filtering on
  // `requiresAdmission` instead of on `kind` hides it and leaves the screen with
  // no button at all.
  it("still offers an ordinary tier that does not require admission", async () => {
    eventFindMany.mockResolvedValue([
      eventRow({
        tiers: [
          {
            id: TIER_ID,
            kind: "free_rsvp",
            title: "Open door",
            capacity: 50,
            claimed: 0,
            requiresAdmission: false,
          },
        ],
      }),
    ]);
    const res = await request(app).get("/v1/events");
    expect(res.body.events[0].tiers).toHaveLength(1);
  });

  it.each([
    ["screening", "pending"],
    ["pending_review", "pending"],
    ["auto_approved", "admitted"],
    ["approved", "admitted"],
    ["waitlisted", "reserve"],
    ["revoked", "reserve"],
  ])("reports tier %s to the applicant as %s", async (tier, expected) => {
    eventFindMany.mockResolvedValue([eventRow({ applications: [{ tier }] })]);
    const res = await request(app).get("/v1/events");
    expect(res.body.events[0].admission).toBe(expected);
  });

  // The score, the thresholds and the cohort ratio are the founder's tuning
  // instruments. A number that reads as a rating OF THE PERSON is the one thing
  // this product does not put on screen.
  it("leaks no score, threshold or ratio", async () => {
    eventFindMany.mockResolvedValue([
      eventRow({ applications: [{ tier: "approved" }] }),
    ]);
    const res = await request(app).get("/v1/events");
    const body = JSON.stringify(res.body);
    for (const forbidden of [
      "scoreAtTiering",
      "genderAtTiering",
      "autoApproveScore",
      "reviewFloorScore",
      "targetMaleShare",
      "ratioTolerance",
      "admissionPolicy",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  // Matching is same-city, so a guest with no market would be invited to a room
  // where nobody can be matched with them.
  it("answers empty for a caller with no dating city", async () => {
    profileFindUnique.mockResolvedValue({ homeCityKey: null });
    const res = await request(app).get("/v1/events");
    expect(res.body).toEqual({ events: [] });
    expect(eventFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /v1/events/:id/apply", () => {
  beforeEach(() => {
    eventFindUnique.mockResolvedValue({
      id: EVENT_ID,
      cityKey: "ua:kyiv",
      status: "upcoming",
      admissionClosesAt: null,
    });
    applicationUpsert.mockResolvedValue({ id: "app-1", tier: "screening" });
  });

  it("applies and tiers a verified applicant immediately", async () => {
    tierOneApplication.mockResolvedValue("auto_approved");
    const res = await request(app).post(`/v1/events/${EVENT_ID}/apply`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admission: "admitted" });
    expect(tierOneApplication).toHaveBeenCalledWith("app-1");
  });

  // Someone who applies AFTER verifying would otherwise sit in `screening`
  // until a human pressed a button, because the pipeline hook already fired.
  it("falls back to the stored tier when tiering cannot decide", async () => {
    tierOneApplication.mockResolvedValue(null);
    const res = await request(app).post(`/v1/events/${EVENT_ID}/apply`).send({});
    expect(res.body).toEqual({ admission: "pending" });
  });

  it("does not re-tier an application that already has a decision", async () => {
    applicationUpsert.mockResolvedValue({ id: "app-1", tier: "approved" });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/apply`).send({});
    expect(tierOneApplication).not.toHaveBeenCalled();
    expect(res.body).toEqual({ admission: "admitted" });
  });

  it("refuses an event in another market", async () => {
    profileFindUnique.mockResolvedValue({ homeCityKey: "ua:kharkiv" });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/apply`).send({});
    expect(res.status).toBe(403);
    expect(applicationUpsert).not.toHaveBeenCalled();
  });

  it("refuses once admission has closed", async () => {
    eventFindUnique.mockResolvedValue({
      id: EVENT_ID,
      cityKey: "ua:kyiv",
      status: "upcoming",
      admissionClosesAt: new Date(Date.now() - 1000),
    });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/apply`).send({});
    expect(res.status).toBe(409);
    expect(applicationUpsert).not.toHaveBeenCalled();
  });

  it.each(["draft", "concluded", "cancelled"])("refuses a %s event", async (status) => {
    eventFindUnique.mockResolvedValue({
      id: EVENT_ID,
      cityKey: "ua:kyiv",
      status,
      admissionClosesAt: null,
    });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/apply`).send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/events/:id/ticket", () => {
  it("claims and reports the ticket", async () => {
    claimEventTicket.mockResolvedValue({ ok: true, ticketId: "t1", created: true });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/ticket`).send({ tierId: TIER_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ticketId: "t1", created: true });
  });

  it("requires a tier", async () => {
    const res = await request(app).post(`/v1/events/${EVENT_ID}/ticket`).send({});
    expect(res.status).toBe(400);
    expect(claimEventTicket).not.toHaveBeenCalled();
  });

  // The status carries the DIFFERENCE: "the room is full" and "you are not on
  // the list" need different sentences on screen.
  it.each([
    ["event_not_found", 404],
    ["tier_not_found", 404],
    ["not_admitted", 403],
    ["tier_full", 409],
    ["event_closed", 409],
  ])("maps %s to %i", async (reason, status) => {
    claimEventTicket.mockResolvedValue({ ok: false, reason });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/ticket`).send({ tierId: TIER_ID });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: reason });
  });
});

describe("GET /v1/events/:id/ticket/qr", () => {
  it("mints a code", async () => {
    mintTicketQr.mockResolvedValue({ code: "c", expiresAt: "2026-09-12T18:01:30.000Z", ticketId: "t1" });
    const res = await request(app).get(`/v1/events/${EVENT_ID}/ticket/qr`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("c");
  });

  // Signing with a blank secret validates every forgery while looking exactly
  // like a working door — so it refuses instead.
  it("refuses to mint without a strong secret", async () => {
    envMock.EVENT_QR_SECRET = "";
    const res = await request(app).get(`/v1/events/${EVENT_ID}/ticket/qr`);
    expect(res.status).toBe(503);
    expect(mintTicketQr).not.toHaveBeenCalled();
  });

  it("answers 404 when the caller holds no ticket", async () => {
    mintTicketQr.mockResolvedValue(null);
    const res = await request(app).get(`/v1/events/${EVENT_ID}/ticket/qr`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/events/:id/ticket/rotate", () => {
  it("rotates", async () => {
    rotateTicketNonce.mockResolvedValue(true);
    const res = await request(app).post(`/v1/events/${EVENT_ID}/ticket/rotate`).send({});
    expect(res.status).toBe(200);
  });

  it("answers 404 when there is nothing to rotate", async () => {
    rotateTicketNonce.mockResolvedValue(false);
    const res = await request(app).post(`/v1/events/${EVENT_ID}/ticket/rotate`).send({});
    expect(res.status).toBe(404);
  });
});
