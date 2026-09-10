/**
 * HTTP boundary of `/v1/venues/*` — the iOS standby canvas.
 *
 * The list is the canvas talking (either rail, mocked here the way
 * `scratch-map-api.test.ts` mocks it); the photo route is reached by a signed
 * link and nothing else, so most of what is worth pinning is which links it
 * refuses. Prisma and Google are mocked: no SQL, no Places bill.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BOT_TOKEN = "123456:test-bot-token-for-venues";
const VENUE_ID = "33333333-3333-4333-8333-333333333333";
const DAY_MS = 24 * 60 * 60 * 1000;
const originalPlacesKey = process.env.PLACES_API_KEY;

vi.mock("../config.js", () => ({
  env: { BOT_TOKEN, PUBLIC_BASE_URL: "https://api.test/" },
}));

const userFindUnique = vi.fn();
const venueFindMany = vi.fn();
const venueFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    curatedVenue: {
      findMany: (...a: unknown[]) => venueFindMany(...a),
      findUnique: (...a: unknown[]) => venueFindUnique(...a),
    },
  },
}));

vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "me";
    next();
  },
}));

const { venuesRouter, resetVenuePhotoCache } = await import("./routes/venues.js");
const { resetShowcaseCache } = await import("../services/curated-venue.js");
const { venuePhotoUrl } = await import("./showcase-photos.js");

function buildApp() {
  const app = express();
  app.use("/v1/venues", venuesRouter);
  return app;
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VENUE_ID,
    placeId: "ChIJ-sens",
    name: "Sens",
    address: "Mykilskyi Ln, 1, Kyiv",
    category: "cafe",
    priority: 1,
    lat: 50.4401,
    lng: 30.5486,
    editorialSummary: null,
    vibeTags: ["books", "quiet", "coffee"],
    facetTags: ["quiet"],
    utcOffsetMinutes: 180,
    openingHours: {
      periods: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
    },
    photoRefs: ["places/ChIJ-sens/photos/abc"],
    rating: 4.7,
    userRatingCount: 812,
    ...overrides,
  };
}

/** Path + query of a link the list would mint, ready for supertest. */
function signedPath(id = VENUE_ID, width = 1200, now = Date.now()): string {
  const url = new URL(venuePhotoUrl(id, width, now));
  return url.pathname + url.search;
}

const jpeg = () => new Response("image", { headers: { "content-type": "image/jpeg" } });

beforeEach(() => {
  userFindUnique.mockReset();
  venueFindMany.mockReset();
  venueFindUnique.mockReset();
  resetShowcaseCache();
  resetVenuePhotoCache();
  process.env.PLACES_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.PLACES_API_KEY = originalPlacesKey;
});

describe("GET /v1/venues/showcase", () => {
  it("defaults to the caller's home city", async () => {
    userFindUnique.mockResolvedValue({ profile: { homeCityKey: "ua:kyiv" } });
    venueFindMany.mockResolvedValue([catalogRow()]);

    const res = await request(buildApp()).get("/v1/venues/showcase");

    expect(res.status).toBe(200);
    expect(res.body.cityKey).toBe("ua:kyiv");
    expect(venueFindMany.mock.calls[0][0].where.cityKey).toBe("ua:kyiv");
    expect(res.body.venues).toHaveLength(1);
    expect(res.body.venues[0]).toMatchObject({
      id: VENUE_ID,
      placeId: "ChIJ-sens",
      name: "Sens",
      category: "cafe",
      utcOffsetMinutes: 180,
      openingHours: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
    });
  });

  it("answers an empty list, not an error, for a person with no city yet", async () => {
    userFindUnique.mockResolvedValue({ profile: null });

    const res = await request(buildApp()).get("/v1/venues/showcase");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cityKey: null, venues: [] });
    expect(venueFindMany).not.toHaveBeenCalled();
  });

  it("takes an explicit city without looking the person up", async () => {
    venueFindMany.mockResolvedValue([]);

    const res = await request(buildApp()).get("/v1/venues/showcase?cityKey=ua:odesa");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cityKey: "ua:odesa", venues: [] });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a malformed city key", async () => {
    const res = await request(buildApp()).get("/v1/venues/showcase?cityKey=Kyiv%20City");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad-city-key");
    expect(venueFindMany).not.toHaveBeenCalled();
  });

  it("signs both photo links with the venue in the PATH — the client caches by path", async () => {
    venueFindMany.mockResolvedValue([catalogRow()]);

    const res = await request(buildApp()).get("/v1/venues/showcase?cityKey=ua:kyiv");
    const venue = res.body.venues[0];
    const card = new URL(venue.photoUrl);
    const pin = new URL(venue.thumbnailUrl);

    expect(card.origin).toBe("https://api.test");
    expect(card.pathname).toBe(`/v1/venues/${VENUE_ID}/photo`);
    expect(pin.pathname).toBe(`/v1/venues/${VENUE_ID}/photo`);
    expect(card.searchParams.get("w")).toBe("1200");
    expect(pin.searchParams.get("w")).toBe("240");
    // The Places resource name never leaves the server.
    expect(JSON.stringify(res.body)).not.toContain("places/ChIJ-sens/photos");
    expect(venue).not.toHaveProperty("hasPhoto");
    expect(venue).not.toHaveProperty("priority");
  });

  it("mints no photo links for a place the catalog has no photo for yet", async () => {
    venueFindMany.mockResolvedValue([catalogRow({ photoRefs: [] })]);

    const res = await request(buildApp()).get("/v1/venues/showcase?cityKey=ua:kyiv");

    expect(res.body.venues[0].photoUrl).toBeNull();
    expect(res.body.venues[0].thumbnailUrl).toBeNull();
  });
});

describe("GET /v1/venues/:id/photo", () => {
  it("serves the photo a signed link names, at the signed width", async () => {
    venueFindUnique.mockResolvedValue({ active: true, photoRefs: ["places/x/photos/y"] });
    const fetchMock = vi.fn().mockResolvedValue(jpeg());
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(buildApp()).get(signedPath(VENUE_ID, 240));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(String(fetchMock.mock.calls[0][0])).toContain("places/x/photos/y/media?maxWidthPx=240");
  });

  it("refuses a forged signature before touching the catalog or Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const forged = signedPath().replace(/sig=[0-9a-f]+/, "sig=000000000000000000000000");

    const res = await request(buildApp()).get(forged);

    expect(res.status).toBe(403);
    expect(venueFindUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a link moved to another venue or another width", async () => {
    const thumb = signedPath(VENUE_ID, 240);
    const wider = thumb.replace("w=240", "w=1200");
    const other = thumb.replace(VENUE_ID, "44444444-4444-4444-8444-444444444444");

    expect((await request(buildApp()).get(wider)).status).toBe(403);
    expect((await request(buildApp()).get(other)).status).toBe(403);
  });

  it("refuses an expired link", async () => {
    const res = await request(buildApp()).get(signedPath(VENUE_ID, 1200, Date.now() - 5 * DAY_MS));

    expect(res.status).toBe(403);
  });

  it("answers 400 for a malformed link rather than a signature check", async () => {
    const res = await request(buildApp()).get("/v1/venues/not-a-uuid/photo?w=1200&e=1&sig=x");
    const oddWidth = await request(buildApp()).get(
      signedPath().replace("w=1200", "w=777"),
    );

    expect(res.status).toBe(400);
    expect(oddWidth.status).toBe(400);
  });

  it("serves the second request from memory — the whole city sees the same photos", async () => {
    venueFindUnique.mockResolvedValue({ active: true, photoRefs: ["places/x/photos/y"] });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jpeg()));
    vi.stubGlobal("fetch", fetchMock);

    expect((await request(buildApp()).get(signedPath())).status).toBe(200);
    expect((await request(buildApp()).get(signedPath())).status).toBe(200);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(venueFindUnique).toHaveBeenCalledOnce();
  });

  it("answers 404 for a retired venue — its links stop working with it", async () => {
    venueFindUnique.mockResolvedValue({ active: false, photoRefs: ["places/x/photos/y"] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(buildApp()).get(signedPath());

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the server has no Places key", async () => {
    delete process.env.PLACES_API_KEY;

    const res = await request(buildApp()).get(signedPath());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("photos-unavailable");
  });

  it("answers 502 and caches nothing when Google refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    venueFindUnique.mockResolvedValue({ active: true, photoRefs: ["places/x/photos/y"] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(jpeg());
    vi.stubGlobal("fetch", fetchMock);

    expect((await request(buildApp()).get(signedPath())).status).toBe(502);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[venues]"));
    // A failure is not remembered: the next open gets a real attempt.
    expect((await request(buildApp()).get(signedPath())).status).toBe(200);
    warn.mockRestore();
  });
});
