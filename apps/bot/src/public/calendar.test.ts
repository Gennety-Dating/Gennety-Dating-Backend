/**
 * Integration test for the `/v1/calendar/*` Mini App endpoints.
 *
 * Both endpoints authenticate via Telegram `initData` HMAC (covered in
 * `init-data.test.ts`) and delegate to the scheduler module for the DB
 * / scheduling logic. So this test focuses on:
 *   - Auth surface: missing header, malformed scheme, signed by wrong token.
 *   - Body / query validation.
 *   - HTTP status mapping for each scheduler failure reason.
 *   - Happy paths.
 *
 * The scheduler logic itself is exhaustively covered by
 * `handlers/matching/scheduler.test.ts` — here we mock the functions so
 * the test stays focused on the HTTP boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-calendar-suite";
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
  },
}));

const processSlots = vi.fn();
const getState = vi.fn();
vi.mock("../handlers/matching/scheduler.js", () => ({
  processCalendarSlotsUpdate: processSlots,
  getCalendarState: getState,
}));

const { createCalendarRouter } = await import("./routes/calendar.js");

const fakeApi = {} as Parameters<typeof createCalendarRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/calendar", createCalendarRouter(fakeApi));
  return app;
}

function signInitData(
  botToken: string,
  overrides: { authDate?: number; user?: Record<string, unknown> } = {},
): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(overrides.authDate ?? Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAH_test");
  params.set(
    "user",
    JSON.stringify(
      overrides.user ?? {
        id: 5986970093,
        first_name: "Pro",
        username: "pro",
      },
    ),
  );
  const sortedKeys = [...params.keys()].sort();
  const dcs = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dcs).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("POST /v1/calendar/pick", () => {
  beforeEach(() => {
    processSlots.mockReset();
    getState.mockReset();
  });

  it("returns 200 and the pick result on the happy path with the new pickedIsos array shape", async () => {
    processSlots.mockResolvedValueOnce({
      ok: true,
      mySlots: ["2026-05-09T19:00:00.000Z"],
      peerSlots: [],
      agreedTime: null,
      bothPicked: false,
    });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({
        matchId: VALID_UUID,
        pickedIsos: ["2026-05-09T19:00:00.000Z"],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mySlots).toEqual(["2026-05-09T19:00:00.000Z"]);
    expect(res.body.agreedTime).toBeNull();
    expect(processSlots).toHaveBeenCalledWith(
      fakeApi,
      5986970093n,
      VALID_UUID,
      ["2026-05-09T19:00:00.000Z"],
    );
  });

  it("forwards an agreedTime when the update produced an overlap", async () => {
    processSlots.mockResolvedValueOnce({
      ok: true,
      mySlots: ["2026-05-09T19:00:00.000Z"],
      peerSlots: ["2026-05-09T19:00:00.000Z"],
      agreedTime: "2026-05-09T19:00:00.000Z",
      bothPicked: true,
    });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, pickedIsos: ["2026-05-09T19:00:00.000Z"] });

    expect(res.status).toBe(200);
    expect(res.body.agreedTime).toBe("2026-05-09T19:00:00.000Z");
    expect(res.body.bothPicked).toBe(true);
  });

  it("still accepts the legacy single-`pickedIso` shape (older Mini App bundles)", async () => {
    processSlots.mockResolvedValueOnce({
      ok: true,
      mySlots: ["2026-05-09T19:00:00.000Z"],
      peerSlots: [],
      agreedTime: null,
      bothPicked: false,
    });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, pickedIso: "2026-05-09T19:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(processSlots).toHaveBeenCalledWith(
      fakeApi,
      5986970093n,
      VALID_UUID,
      ["2026-05-09T19:00:00.000Z"],
    );
  });

  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .send({ matchId: VALID_UUID, pickedIsos: [] });
    expect(res.status).toBe(401);
    expect(processSlots).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization uses a non-tma scheme", async () => {
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", "Bearer something")
      .send({ matchId: VALID_UUID, pickedIsos: [] });
    expect(res.status).toBe(401);
    expect(processSlots).not.toHaveBeenCalled();
  });

  it("returns 401 when initData was signed by a different bot token", async () => {
    const initData = signInitData("999:other-token");
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, pickedIsos: [] });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad-hash");
    expect(processSlots).not.toHaveBeenCalled();
  });

  it("returns 400 when matchId is missing", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ pickedIsos: [] });
    expect(res.status).toBe(400);
    expect(processSlots).not.toHaveBeenCalled();
  });

  it("returns 400 when neither pickedIsos nor pickedIso is provided", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(400);
    expect(processSlots).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID matchId with 404", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "test-smoke-99999", pickedIsos: [] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("match-not-found");
    expect(processSlots).not.toHaveBeenCalled();
  });

  it("maps not-participant → 403", async () => {
    processSlots.mockResolvedValueOnce({ ok: false, reason: "not-participant" });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, pickedIsos: [] });
    expect(res.status).toBe(403);
  });

  it("maps wrong-state, invalid-slot, invalid-iso → 400", async () => {
    const initData = signInitData(BOT_TOKEN);
    for (const reason of ["wrong-state", "invalid-slot", "invalid-iso"] as const) {
      processSlots.mockResolvedValueOnce({ ok: false, reason });
      const res = await request(buildApp())
        .post("/v1/calendar/pick")
        .set("Authorization", `tma ${initData}`)
        .send({ matchId: VALID_UUID, pickedIsos: [] });
      expect(res.status, `for ${reason}`).toBe(400);
      expect(res.body.error).toBe(reason);
    }
  });
});

describe("GET /v1/calendar/state", () => {
  beforeEach(() => {
    processSlots.mockReset();
    getState.mockReset();
  });

  it("returns 200 with the full state envelope on the happy path", async () => {
    getState.mockResolvedValueOnce({
      ok: true,
      proposedTimes: ["2026-05-09T19:00:00.000Z", "2026-05-10T19:00:00.000Z"],
      mySlots: ["2026-05-09T19:00:00.000Z"],
      peerSlots: ["2026-05-10T19:00:00.000Z"],
      agreedTime: null,
      isFirstMover: false,
    });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .get(`/v1/calendar/state?matchId=${VALID_UUID}`)
      .set("Authorization", `tma ${initData}`);

    expect(res.status).toBe(200);
    expect(res.body.proposedTimes.length).toBe(2);
    expect(res.body.mySlots).toEqual(["2026-05-09T19:00:00.000Z"]);
    expect(res.body.peerSlots).toEqual(["2026-05-10T19:00:00.000Z"]);
    expect(res.body.isFirstMover).toBe(false);
    expect(getState).toHaveBeenCalledWith(5986970093n, VALID_UUID);
  });

  it("returns 401 when initData is missing", async () => {
    const res = await request(buildApp()).get(`/v1/calendar/state?matchId=${VALID_UUID}`);
    expect(res.status).toBe(401);
    expect(getState).not.toHaveBeenCalled();
  });

  it("returns 400 when matchId is missing from the query", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get(`/v1/calendar/state`)
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(400);
    expect(getState).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID matchId with 404 before hitting the scheduler", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get(`/v1/calendar/state?matchId=junk`)
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(404);
    expect(getState).not.toHaveBeenCalled();
  });

  it("maps not-participant → 403", async () => {
    getState.mockResolvedValueOnce({ ok: false, reason: "not-participant" });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get(`/v1/calendar/state?matchId=${VALID_UUID}`)
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(403);
  });

  it("maps wrong-state → 400", async () => {
    getState.mockResolvedValueOnce({ ok: false, reason: "wrong-state" });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get(`/v1/calendar/state?matchId=${VALID_UUID}`)
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(400);
  });
});
