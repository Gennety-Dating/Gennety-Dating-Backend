/**
 * The venue door portal, `/gk/*` (LAUNCH_EVENTS_PRODUCT_SPEC.md §8).
 *
 * The two properties worth guarding are both invisible from a happy path: a
 * staff token is scoped to ONE event and revocable (a phone left behind a bar
 * must not open next month's party), and a refusal at the door is an HTTP 200
 * carrying a NAMED outcome — staff have to say a different sentence for each
 * one, and a 4xx with a single message makes the portal useless exactly when it
 * matters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const envMock = { EVENTS_FEATURE_ENABLED: true, EVENT_QR_SECRET: "a".repeat(64) };
vi.mock("../config.js", () => ({ env: envMock }));

const staffTokenFindMany = vi.fn();
const eventFindUnique = vi.fn();
const tierFindMany = vi.fn();
const ticketFindMany = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    eventStaffToken: { findMany: (...a: unknown[]) => staffTokenFindMany(...a) },
    event: { findUnique: (...a: unknown[]) => eventFindUnique(...a) },
    eventTicketTier: { findMany: (...a: unknown[]) => tierFindMany(...a) },
    eventTicket: { findMany: (...a: unknown[]) => ticketFindMany(...a) },
  },
}));

// Real bcrypt would make every request in this file cost a hash comparison; the
// token-matching LOGIC is what is under test, not bcrypt itself.
const compare = vi.fn();
vi.mock("bcryptjs", () => ({ default: { compare: (...a: unknown[]) => compare(...a) } }));

const scanEventTicket = vi.fn();
const redeemPerk = vi.fn();
vi.mock("../services/event-ticket.js", () => ({
  scanEventTicket: (...a: unknown[]) => scanEventTicket(...a),
  redeemPerk: (...a: unknown[]) => redeemPerk(...a),
}));

vi.mock("./rate-limit.js", () => ({
  gatekeeperLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { gatekeeperRouter } = await import("./routes/gatekeeper.js");

const app = express();
app.use(express.json());
app.use("/gk", gatekeeperRouter);

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "99999999-9999-4999-8999-999999999999";
const TOKEN_ID = "55555555-5555-4555-8555-555555555555";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "door-key";

function auth(): [string, string] {
  return ["Authorization", `Bearer ${KEY}`];
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.EVENTS_FEATURE_ENABLED = true;
  envMock.EVENT_QR_SECRET = "a".repeat(64);
  staffTokenFindMany.mockResolvedValue([
    { id: TOKEN_ID, tokenHash: "hash", label: "Front door" },
  ]);
  compare.mockResolvedValue(true);
});

describe("staff auth", () => {
  it("opens the event the token was minted for", async () => {
    eventFindUnique.mockResolvedValue({
      id: EVENT_ID,
      title: "Launch night",
      venueName: "Aroma Kava",
      startsAt: new Date("2026-09-12T18:00:00.000Z"),
      endsAt: new Date("2026-09-12T23:00:00.000Z"),
      timeZone: "Europe/Kyiv",
      status: "upcoming",
    });
    const res = await request(app).post(`/gk/${EVENT_ID}/auth`).set(...auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.staff).toEqual({ label: "Front door" });
  });

  it("refuses without a bearer token", async () => {
    const res = await request(app).post(`/gk/${EVENT_ID}/auth`).send({});
    expect(res.status).toBe(401);
    expect(staffTokenFindMany).not.toHaveBeenCalled();
  });

  it("refuses a token that matches no live hash", async () => {
    compare.mockResolvedValue(false);
    const res = await request(app).post(`/gk/${EVENT_ID}/auth`).set(...auth()).send({});
    expect(res.status).toBe(401);
  });

  // The event id in the URL is what keeps the bcrypt sweep bounded to one
  // party's handful of doors instead of every token ever minted — and it is
  // also what scopes a token to its own event.
  it("only ever compares tokens belonging to the event in the URL", async () => {
    await request(app).post(`/gk/${OTHER_EVENT}/auth`).set(...auth()).send({});
    expect(staffTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: OTHER_EVENT, revokedAt: null } }),
    );
  });

  // A phone left behind a bar must not open the next party.
  it("ignores a revoked token", async () => {
    staffTokenFindMany.mockResolvedValue([]);
    const res = await request(app).post(`/gk/${EVENT_ID}/auth`).set(...auth()).send({});
    expect(res.status).toBe(401);
    expect(compare).not.toHaveBeenCalled();
  });

  it.each([
    ["post", "/auth"],
    ["post", "/scan"],
    ["get", "/stats"],
    ["get", "/manifest"],
  ])("guards %s %s", async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ](`/gk/${EVENT_ID}${path}`).send({});
    expect(res.status).toBe(401);
  });
});

describe("the feature flag", () => {
  it("answers 404 while off, without scanning", async () => {
    envMock.EVENTS_FEATURE_ENABLED = false;
    const res = await request(app)
      .post(`/gk/${EVENT_ID}/scan`)
      .set(...auth())
      .send({ code: "x" });
    expect(res.status).toBe(404);
    expect(scanEventTicket).not.toHaveBeenCalled();
  });
});

describe("POST /scan", () => {
  it("admits and reports the outcome by name", async () => {
    scanEventTicket.mockResolvedValue({ ok: true, outcome: "admitted", ticketId: TICKET_ID });
    const res = await request(app)
      .post(`/gk/${EVENT_ID}/scan`)
      .set(...auth())
      .send({ code: "code" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: "admitted" });
    // The token that opened the door is recorded, so a disputed entry has an
    // owner rather than just a timestamp.
    expect(scanEventTicket).toHaveBeenCalledWith("code", EVENT_ID, TOKEN_ID);
  });

  // A refusal is 200 on purpose: staff are reading a screen with a person in
  // front of them, and "expired, ask them to refresh" is a different sentence
  // from "this ticket is already inside".
  it.each([
    "bad_signature",
    "expired",
    "malformed",
    "wrong_version",
    "wrong_event",
    "unknown_ticket",
    "stale_code",
    "revoked",
    "already_used",
  ])("answers 200 with the named outcome %s", async (outcome) => {
    scanEventTicket.mockResolvedValue({ ok: false, outcome });
    const res = await request(app)
      .post(`/gk/${EVENT_ID}/scan`)
      .set(...auth())
      .send({ code: "code" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, outcome });
  });

  it("requires a code", async () => {
    const res = await request(app).post(`/gk/${EVENT_ID}/scan`).set(...auth()).send({});
    expect(res.status).toBe(400);
    expect(scanEventTicket).not.toHaveBeenCalled();
  });

  // Verifying with a blank secret would accept every forgery while looking
  // exactly like a working door.
  it("refuses to verify without a strong secret", async () => {
    envMock.EVENT_QR_SECRET = "";
    const res = await request(app)
      .post(`/gk/${EVENT_ID}/scan`)
      .set(...auth())
      .send({ code: "code" });
    expect(res.status).toBe(503);
    expect(scanEventTicket).not.toHaveBeenCalled();
  });
});

describe("POST /perk/:ticketId", () => {
  it("pours one drink and scopes the ticket to this event", async () => {
    redeemPerk.mockResolvedValue({ ok: true });
    const res = await request(app)
      .post(`/gk/${EVENT_ID}/perk/${TICKET_ID}`)
      .set(...auth())
      .send({});
    expect(res.status).toBe(200);
    expect(redeemPerk).toHaveBeenCalledWith(TICKET_ID, EVENT_ID);
  });

  it("passes a refusal through by name", async () => {
    redeemPerk.mockResolvedValue({ ok: false, reason: "already_redeemed" });
    const res = await request(app)
      .post(`/gk/${EVENT_ID}/perk/${TICKET_ID}`)
      .set(...auth())
      .send({});
    expect(res.body).toEqual({ ok: false, reason: "already_redeemed" });
  });
});

describe("GET /stats", () => {
  it("counts the room and buckets arrivals", async () => {
    tierFindMany.mockResolvedValue([
      { id: "t", title: "General", capacity: 50, claimed: 40 },
    ]);
    ticketFindMany.mockResolvedValue([
      { checkedInAt: new Date("2026-09-12T18:07:00.000Z"), perkRedeemedAt: new Date() },
      { checkedInAt: new Date("2026-09-12T18:11:00.000Z"), perkRedeemedAt: null },
      { checkedInAt: new Date("2026-09-12T18:22:00.000Z"), perkRedeemedAt: null },
    ]);

    const res = await request(app).get(`/gk/${EVENT_ID}/stats`).set(...auth());

    expect(res.body).toMatchObject({
      insideNow: 3,
      perksRedeemed: 1,
      claimedTotal: 40,
      capacityTotal: 50,
    });
    // Quarter-hours, so a rush reads as a shape rather than a running total.
    expect(res.body.arrivals).toEqual([
      { at: "2026-09-12T18:00:00.000Z", count: 2 },
      { at: "2026-09-12T18:15:00.000Z", count: 1 },
    ]);
  });
});

describe("GET /manifest", () => {
  it("carries the guest list for the door to work off", async () => {
    ticketFindMany.mockResolvedValue([
      {
        id: TICKET_ID,
        checkedInAt: null,
        user: { firstName: "Ева", age: 25, profile: { photos: ["p1"] } },
      },
    ]);
    const res = await request(app).get(`/gk/${EVENT_ID}/manifest`).set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.guests).toEqual([
      { ticketId: TICKET_ID, firstName: "Ева", age: 25, photo: "p1", checkedInAt: null },
    ]);
  });

  it("leaves out revoked tickets", async () => {
    ticketFindMany.mockResolvedValue([]);
    await request(app).get(`/gk/${EVENT_ID}/manifest`).set(...auth());
    expect(ticketFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: EVENT_ID, status: { not: "revoked" } },
      }),
    );
  });
});
