/**
 * Integration tests for the Location Mini App API (`/v1/location/*`).
 *
 * These mirror the calendar tests' shape: real Express + supertest,
 * mocked Prisma + grammY. We verify:
 *   - TMA initData auth on both endpoints (missing / wrong scheme / wrong token)
 *   - GET /search input validation (min query length, default empty result)
 *   - POST /select input validation (matchId, lat/lng presence, lat/lng range)
 *   - POST /select state validation (match must be `negotiating_venue`)
 *   - POST /select happy path writes vibeLat/Lng/Address for the right side
 *   - POST /select fires `tryFinalize` exactly once
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-location-suite";
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
  },
}));

const matchFindUnique = vi.fn();
const matchUpdate = vi.fn();
const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique, update: matchUpdate },
    user: { findUnique: userFindUnique },
  },
}));

const tryFinalize = vi.fn().mockResolvedValue(undefined);
const sendVenuePostSaveAck = vi.fn().mockResolvedValue(null);
vi.mock("../handlers/matching/venue-negotiation.js", () => ({
  tryFinalize,
  sendVenuePostSaveAck,
}));

const { createLocationRouter } = await import("./routes/location.js");

const fakeApi = {} as Parameters<typeof createLocationRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/location", createLocationRouter(fakeApi));
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

beforeEach(() => {
  matchFindUnique.mockReset();
  matchUpdate.mockReset();
  userFindUnique.mockReset();
  tryFinalize.mockReset();
  tryFinalize.mockResolvedValue(undefined);
  sendVenuePostSaveAck.mockReset();
  sendVenuePostSaveAck.mockResolvedValue(null);
});

describe("GET /v1/location/search", () => {
  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp()).get("/v1/location/search?q=metro");
    expect(res.status).toBe(401);
  });

  it("returns 401 when initData was signed by a different bot token", async () => {
    const initData = signInitData("999:other-token");
    const res = await request(buildApp())
      .get("/v1/location/search?q=metro")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(401);
  });

  it("returns an empty result list (200) when query is too short — saves a Places API call", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/location/search?q=a")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, results: [] });
  });

  it("falls back to a deterministic stub when PLACES_API_KEY is unset", async () => {
    const initData = signInitData(BOT_TOKEN);
    const prevKey = process.env.PLACES_API_KEY;
    delete process.env.PLACES_API_KEY;
    try {
      const res = await request(buildApp())
        .get("/v1/location/search?q=lukyanivska")
        .set("Authorization", `tma ${initData}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.results.length).toBe(1);
      expect(res.body.results[0].name).toMatch(/lukyanivska/i);
    } finally {
      if (prevKey !== undefined) process.env.PLACES_API_KEY = prevKey;
    }
  });
});

describe("POST /v1/location/select", () => {
  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/location/select")
      .send({ matchId: VALID_UUID, lat: 50.45, lng: 30.52 });
    expect(res.status).toBe(401);
  });

  it("returns 400 when matchId is missing", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ lat: 50.45, lng: 30.52 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when lat or lng is missing", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 50.45 });
    expect(res.status).toBe(400);
  });

  it("returns 404 on a non-UUID matchId before hitting Prisma", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "not-a-uuid", lat: 50.45, lng: 30.52 });
    expect(res.status).toBe(404);
    expect(matchFindUnique).not.toHaveBeenCalled();
  });

  it("returns 400 on out-of-range lat/lng (sanity guard before DB write)", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 200, lng: 30.52 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-coords");
  });

  it("returns 404 when the match doesn't exist", async () => {
    matchFindUnique.mockResolvedValueOnce(null);
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 50.45, lng: 30.52 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("match-not-found");
  });

  it("returns 400 when the match is not in `negotiating_venue` (e.g. already scheduled)", async () => {
    matchFindUnique.mockResolvedValueOnce({
      id: VALID_UUID,
      userAId: "uid-A",
      userBId: "uid-B",
      status: "scheduled",
    });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 50.45, lng: 30.52 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("wrong-state");
  });

  it("returns 403 when the caller is not a participant of the match", async () => {
    matchFindUnique.mockResolvedValueOnce({
      id: VALID_UUID,
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating_venue",
    });
    userFindUnique.mockResolvedValueOnce({ id: "uid-other" });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 50.45, lng: 30.52 });
    expect(res.status).toBe(403);
  });

  it("writes vibeLatA/LngA/AddressA when caller is user A and triggers tryFinalize once", async () => {
    matchFindUnique.mockResolvedValueOnce({
      id: VALID_UUID,
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating_venue",
    });
    userFindUnique.mockResolvedValueOnce({ id: "uid-A" });
    matchUpdate.mockResolvedValueOnce({});
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({
        matchId: VALID_UUID,
        lat: 50.45,
        lng: 30.52,
        address: "Lukyanivska Metro Station, Kyiv",
      });

    expect(res.status).toBe(200);
    const updateArg = matchUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArg.where.id).toBe(VALID_UUID);
    expect(updateArg.data).toEqual({
      vibeLatA: 50.45,
      vibeLngA: 30.52,
      vibeAddressA: "Lukyanivska Metro Station, Kyiv",
    });
    // tryFinalize is fire-and-forget but should be invoked exactly once.
    // Wait a tick for the void Promises to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(tryFinalize).toHaveBeenCalledTimes(1);
    expect(tryFinalize).toHaveBeenCalledWith(fakeApi, VALID_UUID);
    // ACK helper drives the side-aware "what's next" chat message.
    expect(sendVenuePostSaveAck).toHaveBeenCalledTimes(1);
    const ackArgs = sendVenuePostSaveAck.mock.calls[0]!;
    expect(ackArgs[0]).toBe(fakeApi);
    expect(ackArgs[1]).toBe(5986970093n); // actor's telegramId
    expect(ackArgs[2]).toBe(VALID_UUID);
    expect(ackArgs[3]).toBe("A"); // side
  });

  it("writes vibeLatB/LngB/AddressB when caller is user B (mirror case)", async () => {
    matchFindUnique.mockResolvedValueOnce({
      id: VALID_UUID,
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating_venue",
    });
    userFindUnique.mockResolvedValueOnce({ id: "uid-B" });
    matchUpdate.mockResolvedValueOnce({});
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 50.45, lng: 30.52, address: null });

    expect(res.status).toBe(200);
    const updateArg = matchUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data).toEqual({
      vibeLatB: 50.45,
      vibeLngB: 30.52,
      vibeAddressB: null,
    });
  });

  it("caps a runaway address string at 256 chars (defensive — Mini App could send anything)", async () => {
    matchFindUnique.mockResolvedValueOnce({
      id: VALID_UUID,
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating_venue",
    });
    userFindUnique.mockResolvedValueOnce({ id: "uid-A" });
    matchUpdate.mockResolvedValueOnce({});
    const initData = signInitData(BOT_TOKEN);
    const huge = "x".repeat(2000);

    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: VALID_UUID, lat: 50.45, lng: 30.52, address: huge });

    expect(res.status).toBe(200);
    const updateArg = matchUpdate.mock.calls[0]![0] as { data: { vibeAddressA: string } };
    expect(updateArg.data.vibeAddressA.length).toBe(256);
  });
});
