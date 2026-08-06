/**
 * Integration test for the NATIVE `/v1/matches/:id/calendar` surface — the JWT
 * twin of the initData-authed Mini App router (`calendar.test.ts`).
 *
 * The scheduling mechanics belong to `processCalendarSlotsUpdate` and are
 * covered there; what this suite pins is the boundary the two surfaces have to
 * agree on — status mapping, the full-set (not delta) submission contract, and
 * the projection, including the timezone the grid must be drawn in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const VALID_UUID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SLOT_A = "2026-08-10T13:00:00.000Z";
const SLOT_B = "2026-08-10T15:30:00.000Z";

vi.mock("../config.js", () => ({ env: { BOT_TOKEN: "123456:test" } }));

const getCalendarState = vi.fn();
const processCalendarSlotsUpdate = vi.fn();
vi.mock("../handlers/matching/scheduler.js", () => ({
  getCalendarState: (...a: unknown[]) => getCalendarState(...a),
  processCalendarSlotsUpdate: (...a: unknown[]) => processCalendarSlotsUpdate(...a),
}));

const userFindUnique = vi.fn();
const matchFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
  },
}));

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = USER_ID;
    next();
  },
}));

const { createNativeCalendarRouter } = await import("./routes/calendar-native.js");
const fakeApi = {} as Parameters<typeof createNativeCalendarRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/matches/:matchId/calendar", createNativeCalendarRouter(fakeApi));
  return app;
}

const okState = {
  ok: true as const,
  proposedTimes: [SLOT_A, SLOT_B],
  mySlots: [SLOT_A],
  peerSlots: [SLOT_B],
  agreedTime: null,
  isFirstMover: false,
};

beforeEach(() => {
  getCalendarState.mockReset();
  processCalendarSlotsUpdate.mockReset();
  userFindUnique.mockReset();
  matchFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ telegramId: -7n, profile: { timeZone: "Europe/Kyiv" } });
  matchFindUnique.mockResolvedValue({ proposedTimes: [new Date(SLOT_A), new Date(SLOT_B)] });
});

describe("GET /v1/matches/:id/calendar", () => {
  it("returns the grid, both sides' marks, and the city timezone to draw them in", async () => {
    getCalendarState.mockResolvedValue(okState);

    const res = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/calendar`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      proposedTimes: [SLOT_A, SLOT_B],
      mySlots: [SLOT_A],
      peerSlots: [SLOT_B],
      agreedTime: null,
      timeZone: "Europe/Kyiv",
    });
    // A read never resolves an overlap; only a submission does.
    expect(res.body.overlapCandidates).toEqual([]);
    expect(getCalendarState).toHaveBeenCalledWith(-7n, VALID_UUID);
  });

  it("falls back to a null timezone when the profile has no city yet", async () => {
    userFindUnique.mockResolvedValue({ telegramId: -7n, profile: null });
    getCalendarState.mockResolvedValue(okState);

    const res = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/calendar`);

    expect(res.body.timeZone).toBeNull();
  });

  // A closed calendar is not a missing match — the client must not go hunting
  // for a routing bug that isn't there.
  it("answers 409 for a closed calendar, 403 for an outsider, 404 for no match", async () => {
    getCalendarState.mockResolvedValue({ ok: false, reason: "wrong-state" });
    expect((await request(buildApp()).get(`/v1/matches/${VALID_UUID}/calendar`)).status).toBe(409);

    getCalendarState.mockResolvedValue({ ok: false, reason: "not-participant" });
    expect((await request(buildApp()).get(`/v1/matches/${VALID_UUID}/calendar`)).status).toBe(403);

    getCalendarState.mockResolvedValue({ ok: false, reason: "match-not-found" });
    expect((await request(buildApp()).get(`/v1/matches/${VALID_UUID}/calendar`)).status).toBe(404);
  });

  it("rejects a non-UUID match id before touching the scheduler", async () => {
    const res = await request(buildApp()).get("/v1/matches/not-a-uuid/calendar");
    expect(res.status).toBe(404);
    expect(getCalendarState).not.toHaveBeenCalled();
  });
});

describe("POST /v1/matches/:id/calendar", () => {
  it("submits the full set and answers with the new state", async () => {
    processCalendarSlotsUpdate.mockResolvedValue({
      ok: true,
      mySlots: [SLOT_A, SLOT_B],
      peerSlots: [SLOT_B],
      agreedTime: null,
      overlapCandidates: [SLOT_B],
      bothPicked: true,
    });

    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/calendar`)
      .send({ slots: [SLOT_A, SLOT_B] });

    expect(res.status).toBe(200);
    expect(processCalendarSlotsUpdate).toHaveBeenCalledWith(fakeApi, -7n, VALID_UUID, [
      SLOT_A,
      SLOT_B,
    ]);
    // The response IS the re-render: the grid rides along even though the
    // scheduler does not echo it, so the client never has to re-fetch.
    expect(res.body.proposedTimes).toEqual([SLOT_A, SLOT_B]);
    expect(res.body.overlapCandidates).toEqual([SLOT_B]);
  });

  it("carries the lock through when exactly one slot is shared", async () => {
    processCalendarSlotsUpdate.mockResolvedValue({
      ok: true,
      mySlots: [SLOT_B],
      peerSlots: [SLOT_B],
      agreedTime: SLOT_B,
      overlapCandidates: [],
      bothPicked: true,
    });

    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/calendar`)
      .send({ slots: [SLOT_B] });

    expect(res.body.agreedTime).toBe(SLOT_B);
    expect(res.body.overlapCandidates).toEqual([]);
  });

  // An empty set is how unmarking is expressed — it must reach the scheduler,
  // not be mistaken for a malformed body.
  it("accepts an empty set as a real submission", async () => {
    processCalendarSlotsUpdate.mockResolvedValue({
      ok: true,
      mySlots: [],
      peerSlots: [SLOT_B],
      agreedTime: null,
      overlapCandidates: [],
      bothPicked: false,
    });

    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/calendar`)
      .send({ slots: [] });

    expect(res.status).toBe(200);
    expect(processCalendarSlotsUpdate).toHaveBeenCalledWith(fakeApi, -7n, VALID_UUID, []);
  });

  it("refuses a missing or non-string set without touching the scheduler", async () => {
    for (const body of [{}, { slots: "13:00" }, { slots: [1, 2] }]) {
      const res = await request(buildApp())
        .post(`/v1/matches/${VALID_UUID}/calendar`)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(processCalendarSlotsUpdate).not.toHaveBeenCalled();
  });

  it("maps a slot outside the grid to 400", async () => {
    processCalendarSlotsUpdate.mockResolvedValue({ ok: false, reason: "invalid-slot" });

    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/calendar`)
      .send({ slots: ["2026-01-01T09:00:00.000Z"] });

    expect(res.status).toBe(400);
  });
});
