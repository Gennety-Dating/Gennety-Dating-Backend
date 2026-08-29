/**
 * The post-event routes (LAUNCH_EVENTS §11).
 *
 * The service tests own the verdict logic; this file owns what the WIRE is
 * allowed to say. Three things carry it: the feature flag is a real gate,
 * "no such event" and "you were not there" must be one answer, and the reveal
 * is fire-and-forget — a thumb that was recorded must never come back as an
 * error because a push failed.
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

const getEventRecap = vi.fn();
const recordThumb = vi.fn();
const submitEventFeedback = vi.fn();
const sendMutualReveal = vi.fn();
vi.mock("../services/event-recap.js", () => ({
  getEventRecap: (...a: unknown[]) => getEventRecap(...a),
  recordThumb: (...a: unknown[]) => recordThumb(...a),
  submitEventFeedback: (...a: unknown[]) => submitEventFeedback(...a),
  sendMutualReveal: (...a: unknown[]) => sendMutualReveal(...a),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    eventTicket: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    eventRoundPairing: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  envMock.EVENTS_FEATURE_ENABLED = true;
  getEventRecap.mockResolvedValue({
    ok: true,
    state: {
      open: true,
      opensAt: null,
      eventTitle: "Launch",
      pairings: [],
      feedbackSubmitted: false,
      discount: null,
    },
  });
  recordThumb.mockResolvedValue({ ok: true, mutual: false, revealTo: null });
  submitEventFeedback.mockResolvedValue({ ok: true, discount: null, granted: false });
  sendMutualReveal.mockResolvedValue(undefined);
});

describe("GET /:id/recap", () => {
  it("404s while the feature is off, without touching the service", async () => {
    envMock.EVENTS_FEATURE_ENABLED = false;
    const res = await request(app).get(`/v1/events/${EVENT_ID}/recap`);
    expect(res.status).toBe(404);
    expect(getEventRecap).not.toHaveBeenCalled();
  });

  // Distinguishing the two would turn this route into a way to test whether an
  // event id exists, which is exactly what an id-addressed read must not be.
  it("answers identically for an unknown event and for someone who was not there", async () => {
    getEventRecap.mockResolvedValue({ ok: false, reason: "unknown_event" });
    const unknown = await request(app).get(`/v1/events/${EVENT_ID}/recap`);
    getEventRecap.mockResolvedValue({ ok: false, reason: "not_attended" });
    const absent = await request(app).get(`/v1/events/${EVENT_ID}/recap`);
    expect(unknown.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(unknown.body).toEqual(absent.body);
  });
});

describe("POST /:id/pairings/:pairingId/thumbs", () => {
  it("refuses a body without a boolean rather than guessing one", async () => {
    const res = await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: "yes" });
    expect(res.status).toBe(400);
    expect(recordThumb).not.toHaveBeenCalled();
  });

  // "Not yet" and "no" are different answers, and the client can render the
  // first — so this is the one refusal on this route worth naming.
  it("names `not_open` separately from a missing pairing", async () => {
    recordThumb.mockResolvedValue({ ok: false, reason: "not_open" });
    const early = await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: true });
    expect(early.status).toBe(409);

    recordThumb.mockResolvedValue({ ok: false, reason: "not_participant" });
    const stranger = await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: true });
    expect(stranger.status).toBe(404);
  });

  it("reveals to the peer only when the service says this tap completed it", async () => {
    await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: true });
    expect(sendMutualReveal).not.toHaveBeenCalled();

    recordThumb.mockResolvedValue({ ok: true, mutual: true, revealTo: PARTNER });
    const res = await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: true });
    expect(res.body).toEqual({ ok: true, mutual: true });
    expect(sendMutualReveal).toHaveBeenCalledWith(PARTNER, VIEWER, EVENT_ID);
  });

  // The verdict is already durable when the reveal is attempted, so a failed
  // push must not come back as an error the user retries — retrying would be
  // a no-op anyway, and the screen would be telling them their answer was lost.
  it("answers ok even when the reveal fails", async () => {
    recordThumb.mockResolvedValue({ ok: true, mutual: true, revealTo: PARTNER });
    sendMutualReveal.mockRejectedValue(new Error("push down"));
    const res = await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mutual: true });
  });

  // Nothing about the peer beyond the mutual bit. `revealTo` is a routing
  // detail and naming it on the wire would leak who the partner is.
  it("never puts the peer's id on the wire", async () => {
    recordThumb.mockResolvedValue({ ok: true, mutual: true, revealTo: PARTNER });
    const res = await request(app)
      .post(`/v1/events/${EVENT_ID}/pairings/${PAIRING_ID}/thumbs`)
      .send({ value: true });
    expect(JSON.stringify(res.body)).not.toContain(PARTNER);
  });
});

describe("POST /:id/feedback", () => {
  it("passes only the three fields it recognises", async () => {
    await request(app)
      .post(`/v1/events/${EVENT_ID}/feedback`)
      .send({ rating: 8, safety: "everything_fine", text: "good", userId: "spoofed" });
    expect(submitEventFeedback).toHaveBeenCalledWith(VIEWER, EVENT_ID, {
      rating: 8,
      safety: "everything_fine",
      text: "good",
    });
  });

  it("coerces nothing — a non-number rating arrives as null, not as NaN", async () => {
    await request(app).post(`/v1/events/${EVENT_ID}/feedback`).send({ rating: "9" });
    expect(submitEventFeedback.mock.calls[0]?.[2]).toEqual({
      rating: null,
      safety: null,
      text: null,
    });
  });

  it("reports a bad submission as 400 and a missing event as 404", async () => {
    submitEventFeedback.mockResolvedValue({ ok: false, reason: "empty" });
    expect((await request(app).post(`/v1/events/${EVENT_ID}/feedback`).send({})).status).toBe(400);
    submitEventFeedback.mockResolvedValue({ ok: false, reason: "not_attended" });
    expect((await request(app).post(`/v1/events/${EVENT_ID}/feedback`).send({})).status).toBe(404);
  });

  it("returns the discount the service actually reports", async () => {
    submitEventFeedback.mockResolvedValue({
      ok: true,
      granted: true,
      discount: { pct: 40, expiresAt: "2026-10-12T00:00:00.000Z" },
    });
    const res = await request(app).post(`/v1/events/${EVENT_ID}/feedback`).send({ rating: 9 });
    expect(res.body).toEqual({
      ok: true,
      granted: true,
      discount: { pct: 40, expiresAt: "2026-10-12T00:00:00.000Z" },
    });
  });
});
