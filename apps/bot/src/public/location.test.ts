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
const profileFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique, update: matchUpdate },
    user: { findUnique: userFindUnique },
    // Read by the departure-point gate (`services/venue-origin.ts`).
    profile: { findUnique: profileFindUnique },
  },
}));

const tryFinalize = vi.fn().mockResolvedValue(undefined);
const sendVenuePostSaveAck = vi.fn().mockResolvedValue(null);
vi.mock("../handlers/matching/venue-negotiation.js", () => ({
  tryFinalize,
  sendVenuePostSaveAck,
}));

const { createLocationRouter, marketBoundingBox } = await import("./routes/location.js");
const { SUPPORTED_MARKETS } = await import("@gennety/shared");

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
  profileFindUnique.mockReset();
  // A Kyiv account by default, so the existing Khreshchatyk fixtures pass the
  // departure-point gate; the gate's own cases override this.
  profileFindUnique.mockResolvedValue({ homeCityKey: "ua:kyiv" });
  // `/search` resolves the DB user too (it restricts results to the caller's
  // own market), so a default identity is needed alongside the per-case
  // `mockResolvedValueOnce` the `/select` tests set up.
  userFindUnique.mockResolvedValue({ id: "uid-A", language: "en" });
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

  it("rejects oversized Places queries", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get(`/v1/location/search?q=${"x".repeat(121)}`)
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Query is too long");
  });

  // The payload itself was untested until 2026-08-09, and that is exactly how
  // `locationRestriction: { circle }` — which `searchText` rejects with a 400 —
  // shipped and made the Mini App's search return nothing for every user in a
  // launched market. Assert the shape Places actually accepts.
  it("restricts the Places query to the caller's market as a RECTANGLE, not a circle", async () => {
    const initData = signInitData(BOT_TOKEN);
    const prevKey = process.env.PLACES_API_KEY;
    process.env.PLACES_API_KEY = "test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ places: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const res = await request(buildApp())
        .get("/v1/location/search?q=lukyanivska")
        .set("Authorization", `tma ${initData}`);
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as {
        locationRestriction?: Record<string, unknown>;
      };
      expect(body.locationRestriction).toBeDefined();
      // The whole bug in one assertion: a circle here is a 400, not a wider search.
      expect(body.locationRestriction).not.toHaveProperty("circle");
      expect(body.locationRestriction).toHaveProperty("rectangle");
      const rect = body.locationRestriction!.rectangle as {
        low: { latitude: number; longitude: number };
        high: { latitude: number; longitude: number };
      };
      expect(rect.low.latitude).toBeLessThan(rect.high.latitude);
      expect(rect.low.longitude).toBeLessThan(rect.high.longitude);
      // Kyiv's centroid must sit inside its own box.
      expect(rect.low.latitude).toBeLessThan(50.45);
      expect(rect.high.latitude).toBeGreaterThan(50.45);
    } finally {
      fetchSpy.mockRestore();
      if (prevKey === undefined) delete process.env.PLACES_API_KEY;
      else process.env.PLACES_API_KEY = prevKey;
    }
  });

  it("drops a Places hit that lands in the box's corner but outside the market circle", async () => {
    const initData = signInitData(BOT_TOKEN);
    const prevKey = process.env.PLACES_API_KEY;
    process.env.PLACES_API_KEY = "test-key";
    // The NE corner of Kyiv's bounding box: inside the rectangle we send,
    // ~80 km from the centroid, so outside the 60 km market.
    const corner = { latitude: 50.99, longitude: 31.36 };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            {
              id: "far",
              displayName: { text: "Corner place" },
              formattedAddress: "Somewhere",
              location: corner,
            },
            {
              id: "near",
              displayName: { text: "Khreshchatyk" },
              formattedAddress: "Kyiv",
              location: { latitude: 50.45, longitude: 30.52 },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const res = await request(buildApp())
        .get("/v1/location/search?q=somewhere")
        .set("Authorization", `tma ${initData}`);
      expect(res.status).toBe(200);
      expect(res.body.results.map((r: { placeId: string }) => r.placeId)).toEqual(["near"]);
    } finally {
      fetchSpy.mockRestore();
      if (prevKey === undefined) delete process.env.PLACES_API_KEY;
      else process.env.PLACES_API_KEY = prevKey;
    }
  });

  it("returns an empty list rather than an error when Places rejects the query", async () => {
    const initData = signInitData(BOT_TOKEN);
    const prevKey = process.env.PLACES_API_KEY;
    process.env.PLACES_API_KEY = "test-key";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 400 }));
    try {
      const res = await request(buildApp())
        .get("/v1/location/search?q=lukyanivska")
        .set("Authorization", `tma ${initData}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, results: [] });
    } finally {
      fetchSpy.mockRestore();
      if (prevKey === undefined) delete process.env.PLACES_API_KEY;
      else process.env.PLACES_API_KEY = prevKey;
    }
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

  // The departure-point gate (PRODUCT_SPEC §3.7). This route is what an older
  // Mini App bundle still saves through, so the server must refuse the pin even
  // when no client-side gate ran.
  it("refuses an origin outside the caller's launched market", async () => {
    matchFindUnique.mockResolvedValueOnce({
      id: VALID_UUID,
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating_venue",
    });
    userFindUnique.mockResolvedValueOnce({ id: "uid-A" });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/location/select")
      .set("Authorization", `tma ${initData}`)
      // Berlin Hauptbahnhof — the pin that used to be saved silently.
      .send({ matchId: VALID_UUID, lat: 52.525, lng: 13.369, address: "Berlin Hbf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("origin-outside-market");
    expect(res.body.market.city).toBe("Kyiv");
    expect(matchUpdate).not.toHaveBeenCalled();
    expect(tryFinalize).not.toHaveBeenCalled();
  });

  it("still saves for an account whose dating city is not a launched market", async () => {
    profileFindUnique.mockResolvedValue({ homeCityKey: "de:berlin" });
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
      .send({ matchId: VALID_UUID, lat: 52.525, lng: 13.369, address: "Berlin Hbf" });

    expect(res.status).toBe(200);
    expect(matchUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("marketBoundingBox", () => {
  // Places wants a rectangle; a market is a circle. The box must therefore
  // CONTAIN the circle — under-including would hide real addresses inside the
  // market, and the per-result circular filter already trims the corners.
  it("contains every extreme point of each market's circle", () => {
    for (const market of SUPPORTED_MARKETS) {
      const box = marketBoundingBox(market);
      const dLat = market.radiusKm / 111.32;
      const dLng = market.radiusKm / (111.32 * Math.cos((market.latitude * Math.PI) / 180));
      const extremes = [
        { latitude: market.latitude + dLat, longitude: market.longitude },
        { latitude: market.latitude - dLat, longitude: market.longitude },
        { latitude: market.latitude, longitude: market.longitude + dLng },
        { latitude: market.latitude, longitude: market.longitude - dLng },
      ];
      for (const p of extremes) {
        expect(p.latitude).toBeGreaterThanOrEqual(box.low.latitude - 1e-9);
        expect(p.latitude).toBeLessThanOrEqual(box.high.latitude + 1e-9);
        expect(p.longitude).toBeGreaterThanOrEqual(box.low.longitude - 1e-9);
        expect(p.longitude).toBeLessThanOrEqual(box.high.longitude + 1e-9);
      }
    }
  });

  // The longitude term must scale with latitude. Using the latitude delta for
  // both axes is the tempting simplification and it silently narrows the box —
  // at Kyiv's ~50° it would cut ~36% off each side, hiding the eastern and
  // western edges of the market from search.
  it("is wider than it is tall away from the equator", () => {
    const kyiv = SUPPORTED_MARKETS.find((m) => m.cityKey === "ua:kyiv");
    expect(kyiv).toBeDefined();
    const box = marketBoundingBox(kyiv!);
    const latSpan = box.high.latitude - box.low.latitude;
    const lngSpan = box.high.longitude - box.low.longitude;
    expect(lngSpan).toBeGreaterThan(latSpan * 1.4);
  });

  it("stays inside legal lat/lng bounds", () => {
    const polar = {
      cityKey: "xx:polar",
      city: "Polar",
      countryCode: "XX",
      latitude: 89.9,
      longitude: 179.9,
      radiusKm: 200,
      aliases: [],
    };
    const box = marketBoundingBox(polar);
    expect(box.high.latitude).toBeLessThanOrEqual(90);
    expect(box.low.latitude).toBeGreaterThanOrEqual(-90);
    expect(box.high.longitude).toBeLessThanOrEqual(180);
    expect(box.low.longitude).toBeGreaterThanOrEqual(-180);
  });
});
