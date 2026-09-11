/**
 * HTTP boundary of `/v1/frequent-places/*`, plus the one function that decides
 * what a match sees. Prisma is mocked (no SQL here — the live-database pass is
 * a separate check); the canvas rail is mocked the way `scratch-map-api.test.ts`
 * mocks it. Only `Date` is faked, so a stay can last fifteen minutes in a test
 * that takes milliseconds.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const venueFindMany = vi.fn();
const visitFindMany = vi.fn();
const visitCreateMany = vi.fn();
const matchFindMany = vi.fn();
const hiddenFindMany = vi.fn();
const hiddenUpsert = vi.fn();
const hiddenDeleteMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
    },
    curatedVenue: { findMany: (...a: unknown[]) => venueFindMany(...a) },
    userPlaceVisit: {
      findMany: (...a: unknown[]) => visitFindMany(...a),
      createMany: (...a: unknown[]) => visitCreateMany(...a),
    },
    match: { findMany: (...a: unknown[]) => matchFindMany(...a) },
    userHiddenPlace: {
      findMany: (...a: unknown[]) => hiddenFindMany(...a),
      upsert: (...a: unknown[]) => hiddenUpsert(...a),
      deleteMany: (...a: unknown[]) => hiddenDeleteMany(...a),
    },
  },
}));

vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "me";
    next();
  },
}));

const { frequentPlacesRouter } = await import("./routes/frequent-places.js");
const { partnerFrequentPlaces, resetFrequentPlacesState } = await import(
  "../services/frequent-places.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/frequent-places", frequentPlacesRouter);
  return app;
}

/** Kyiv, 15:00 local. */
const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const MINUTE = 60_000;
const SENS = { lat: 50.4401, lng: 30.5486 };
const PLACE = "ChIJ-sens";

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    placeId: PLACE,
    name: "Sens",
    category: "cafe",
    priority: 1,
    lat: SENS.lat,
    lng: SENS.lng,
    ...overrides,
  };
}

/** `count` stored visits to Sens, one a day, ending today. */
function storedVisits(count: number, placeId = PLACE) {
  return Array.from({ length: count }, (_, i) => ({
    placeId,
    visitDay: new Date(Date.parse("2026-09-11T00:00:00.000Z") - i * 86_400_000),
  }));
}

/** A point `east` metres east of Sens. */
function eastOfSens(east: number) {
  return {
    lat: SENS.lat,
    lng: SENS.lng + east / (111_320 * Math.cos((SENS.lat * Math.PI) / 180)),
  };
}

const fix = (overrides: Record<string, unknown> = {}) => ({
  ...SENS,
  accuracyM: 10,
  ageSeconds: 2,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetFrequentPlacesState();
  userFindUnique
    .mockReset()
    .mockResolvedValue({ frequentPlacesOptIn: true, profile: { homeCityKey: "ua:kyiv" } });
  userUpdate.mockReset().mockResolvedValue({});
  venueFindMany.mockReset().mockResolvedValue([catalogRow()]);
  visitFindMany.mockReset().mockResolvedValue([]);
  visitCreateMany.mockReset().mockResolvedValue({ count: 1 });
  matchFindMany.mockReset().mockResolvedValue([]);
  hiddenFindMany.mockReset().mockResolvedValue([]);
  hiddenUpsert.mockReset().mockResolvedValue({});
  hiddenDeleteMany.mockReset().mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /v1/frequent-places", () => {
  it("lists a café once it passes four visits, with its count, for the owner", async () => {
    visitFindMany.mockResolvedValue(storedVisits(5));

    const res = await request(buildApp()).get("/v1/frequent-places");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      optIn: true,
      places: [{ placeId: PLACE, name: "Sens", category: "cafe", visits: 5, hidden: false }],
    });
  });

  it("does not list it at four", async () => {
    visitFindMany.mockResolvedValue(storedVisits(4));

    const res = await request(buildApp()).get("/v1/frequent-places");

    expect(res.body.places).toEqual([]);
  });

  it("counts a date the person attended there as a visit", async () => {
    visitFindMany.mockResolvedValue(storedVisits(4));
    matchFindMany.mockResolvedValue([
      { venuePlaceId: PLACE, agreedTime: new Date("2026-09-05T16:00:00.000Z") },
    ]);

    const res = await request(buildApp()).get("/v1/frequent-places");

    expect(res.body.places).toMatchObject([{ placeId: PLACE, visits: 5 }]);
    // Attendance, never mere scheduling: only the caller's own attended side.
    expect(matchFindMany.mock.calls[0][0].where.OR).toEqual([
      { userAId: "me", dateAttendedA: true },
      { userBId: "me", dateAttendedB: true },
    ]);
  });

  it("names a place by the operator's best row when the catalog holds several", async () => {
    venueFindMany.mockResolvedValue([
      catalogRow({ id: "row-2", name: "Sens (KPI)", priority: 2 }),
      catalogRow(),
    ]);
    visitFindMany.mockResolvedValue(storedVisits(5));

    const res = await request(buildApp()).get("/v1/frequent-places");

    expect(res.body.places).toMatchObject([{ name: "Sens" }]);
  });

  it("shows nothing and reads nothing while switched off", async () => {
    userFindUnique.mockResolvedValue({ frequentPlacesOptIn: false, profile: null });

    const res = await request(buildApp()).get("/v1/frequent-places");

    expect(res.body).toEqual({ optIn: false, places: [] });
    expect(visitFindMany).not.toHaveBeenCalled();
  });
});

describe("PUT /v1/frequent-places/opt-in", () => {
  it("refuses anything but a boolean", async () => {
    const res = await request(buildApp()).put("/v1/frequent-places/opt-in").send({ enabled: "no" });

    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("switches collection off and answers the new state", async () => {
    userUpdate.mockImplementation(async () => {
      userFindUnique.mockResolvedValue({ frequentPlacesOptIn: false, profile: null });
      return {};
    });

    const res = await request(buildApp()).put("/v1/frequent-places/opt-in").send({ enabled: false });

    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "me" },
      data: { frequentPlacesOptIn: false },
    });
    expect(res.body).toEqual({ ok: true, optIn: false, places: [] });
  });
});

describe("PUT /v1/frequent-places/:placeId/visibility", () => {
  it("hides a place: it leaves the shown list and stays in the owner's, marked", async () => {
    visitFindMany.mockResolvedValue(storedVisits(5));
    hiddenUpsert.mockImplementation(async () => {
      hiddenFindMany.mockResolvedValue([{ placeId: PLACE }]);
      return {};
    });

    const res = await request(buildApp())
      .put(`/v1/frequent-places/${PLACE}/visibility`)
      .send({ hidden: true });

    expect(res.status).toBe(200);
    expect(hiddenUpsert).toHaveBeenCalledWith({
      where: { userId_placeId: { userId: "me", placeId: PLACE } },
      create: { userId: "me", placeId: PLACE },
      update: {},
    });
    expect(res.body.places).toEqual([
      { placeId: PLACE, name: "Sens", category: "cafe", visits: 5, hidden: true },
    ]);
  });

  it("brings a place back", async () => {
    const res = await request(buildApp())
      .put(`/v1/frequent-places/${PLACE}/visibility`)
      .send({ hidden: false });

    expect(res.status).toBe(200);
    expect(hiddenDeleteMany).toHaveBeenCalledWith({ where: { userId: "me", placeId: PLACE } });
  });

  it("refuses a malformed place id or a non-boolean", async () => {
    const bad = await request(buildApp())
      .put("/v1/frequent-places/not%20a%20place/visibility")
      .send({ hidden: true });
    const notBoolean = await request(buildApp())
      .put(`/v1/frequent-places/${PLACE}/visibility`)
      .send({ hidden: 1 });

    expect(bad.status).toBe(400);
    expect(notBoolean.status).toBe(400);
    expect(hiddenUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /v1/frequent-places/fences", () => {
  it("hands the client its city as circles and the numbers to run on", async () => {
    const res = await request(buildApp()).get("/v1/frequent-places/fences");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      optIn: true,
      cityKey: "ua:kyiv",
      policy: { maxAccuracyM: 50, fixMaxAgeSeconds: 60, probeIntervalSeconds: 600 },
      fences: [{ lat: SENS.lat, lng: SENS.lng, radiusM: 35 }],
    });
  });

  it("answers no fences while switched off, so the client has nothing to send", async () => {
    userFindUnique.mockResolvedValue({ frequentPlacesOptIn: false, profile: null });

    const res = await request(buildApp()).get("/v1/frequent-places/fences");

    expect(res.body.fences).toEqual([]);
    expect(venueFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /v1/frequent-places/presence", () => {
  const post = (body: Record<string, unknown>) =>
    request(buildApp()).post("/v1/frequent-places/presence").send(body);

  it("refuses coordinates that are not numbers, and an empty report", async () => {
    expect((await post(fix({ lat: "50.44" }))).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post(fix({ ageSeconds: -1 }))).status).toBe(400);
  });

  it("refuses a fix from someone who switched the feature off", async () => {
    userFindUnique.mockResolvedValue({ frequentPlacesOptIn: false, profile: null });

    const res = await post(fix());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("opted-out");
  });

  it("never counts a single fix", async () => {
    const res = await post(fix());

    expect(res.body).toEqual({ ok: true });
    expect(visitCreateMany).not.toHaveBeenCalled();
  });

  it("counts two fixes fifteen minutes apart at one café as one visit, on the local day", async () => {
    await post(fix());
    vi.setSystemTime(NOW + 15 * MINUTE);
    const res = await post(fix());

    // The answer is the same either way: a fix is not a receipt.
    expect(res.body).toEqual({ ok: true });
    expect(visitCreateMany).toHaveBeenCalledWith({
      data: [{ userId: "me", placeId: PLACE, visitDay: new Date("2026-09-11T00:00:00.000Z") }],
      skipDuplicates: true,
    });
  });

  it("does not count walking past twice with a departure in between", async () => {
    await post(fix());
    vi.setSystemTime(NOW + 5 * MINUTE);
    await post({ away: true });
    vi.setSystemTime(NOW + 20 * MINUTE);
    await post(fix());

    expect(visitCreateMany).not.toHaveBeenCalled();
  });

  it("ignores a stale fix — it says where someone was, not where they are", async () => {
    await post(fix({ ageSeconds: 120 }));
    vi.setSystemTime(NOW + 15 * MINUTE);
    await post(fix());

    expect(visitCreateMany).not.toHaveBeenCalled();
  });

  it("counts a stay between two cafés 10 m apart for neither", async () => {
    venueFindMany.mockResolvedValue([
      catalogRow({ id: "a", placeId: "ChIJ-a" }),
      catalogRow({ id: "b", placeId: "ChIJ-b", ...eastOfSens(10) }),
    ]);
    const between = eastOfSens(5);

    await post(fix(between));
    vi.setSystemTime(NOW + 20 * MINUTE);
    await post(fix(between));

    expect(visitCreateMany).not.toHaveBeenCalled();
  });
});

describe("partnerFrequentPlaces — what crosses to the match", () => {
  it("is a name and a category per place, and nothing else", async () => {
    visitFindMany.mockResolvedValue(storedVisits(7));

    expect(await partnerFrequentPlaces("me")).toEqual([
      { placeId: PLACE, name: "Sens", category: "cafe" },
    ]);
  });

  it("is empty while the person has the feature off", async () => {
    userFindUnique.mockResolvedValue({ frequentPlacesOptIn: false, profile: null });
    visitFindMany.mockResolvedValue(storedVisits(7));

    expect(await partnerFrequentPlaces("me")).toEqual([]);
  });

  it("drops a place the moment its owner hides it, not ten minutes later", async () => {
    visitFindMany.mockResolvedValue(storedVisits(7));
    expect(await partnerFrequentPlaces("me")).toHaveLength(1);

    hiddenUpsert.mockImplementation(async () => {
      hiddenFindMany.mockResolvedValue([{ placeId: PLACE }]);
      return {};
    });
    await request(buildApp()).put(`/v1/frequent-places/${PLACE}/visibility`).send({ hidden: true });

    expect(await partnerFrequentPlaces("me")).toEqual([]);
  });
});
