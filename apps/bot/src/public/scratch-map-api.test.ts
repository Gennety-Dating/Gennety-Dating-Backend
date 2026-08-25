import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const scratchFindUnique = vi.fn();
const scratchUpsert = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
    userScratchMap: { findUnique: scratchFindUnique, upsert: scratchUpsert },
  },
}));

vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "me";
    next();
  },
}));

const { scratchMapRouter } = await import("./routes/scratch-map.js");
const { tileFor } = await import("@gennety/shared");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/scratch", scratchMapRouter);
  return app;
}

const CENTRE = { lat: 50.4501, lng: 30.5234 };

beforeEach(() => {
  userFindUnique
    .mockReset()
    .mockResolvedValue({ scratchMapOptIn: true, profile: { homeCityKey: "ua:kyiv" } });
  userUpdate.mockReset().mockResolvedValue({});
  scratchFindUnique.mockReset().mockResolvedValue(null);
  scratchUpsert.mockReset().mockImplementation(({ create, update }: any) =>
    Promise.resolve({
      exploredTiles: update?.exploredTiles ?? create.exploredTiles,
      exploredPercent: update?.exploredPercent ?? create.exploredPercent,
      discoveredVenues: update?.discoveredVenues ?? create.discoveredVenues ?? [],
    }),
  );
});

describe("GET /v1/scratch", () => {
  it("answers for a user who has never uncovered anything", async () => {
    const res = await request(buildApp()).get("/v1/scratch");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      optIn: true,
      exploredTiles: [],
      exploredPercent: 0,
      discoveredVenues: [],
    });
  });

  it("reports the opt-in alongside the map, so one call draws the screen", async () => {
    userFindUnique.mockResolvedValue({ scratchMapOptIn: false, profile: null });

    const res = await request(buildApp()).get("/v1/scratch");

    expect(res.body.optIn).toBe(false);
  });
});

describe("POST /v1/scratch/ping", () => {
  it("uncovers a tile and answers with the whole map", async () => {
    const res = await request(buildApp()).post("/v1/scratch/ping").send(CENTRE);

    expect(res.status).toBe(200);
    expect(res.body.uncovered).toBe(true);
    expect(res.body.exploredTiles).toEqual([tileFor(CENTRE.lat, CENTRE.lng)]);
    expect(res.body.exploredPercent).toBeGreaterThan(0);
  });

  // The canvas polls this while the user sits still, which is the common case
  // by far. It must cost a read and no write.
  it("performs no write when nothing new was uncovered", async () => {
    scratchFindUnique.mockResolvedValue({
      exploredTiles: [tileFor(CENTRE.lat, CENTRE.lng)],
      exploredPercent: 0.0003,
      discoveredVenues: [],
    });

    const res = await request(buildApp()).post("/v1/scratch/ping").send(CENTRE);

    expect(res.body.uncovered).toBe(false);
    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  // 409, not 403: it is a setting rather than a permission, and the client's
  // job is to offer the toggle instead of retrying.
  it("refuses without the opt-in", async () => {
    userFindUnique.mockResolvedValue({ scratchMapOptIn: false, profile: null });

    const res = await request(buildApp()).post("/v1/scratch/ping").send(CENTRE);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("opted-out");
  });

  it("refuses a ping from another city", async () => {
    const res = await request(buildApp())
      .post("/v1/scratch/ping")
      .send({ lat: 52.52, lng: 13.405 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("outside-market");
  });

  it("refuses a body with no coordinates", async () => {
    const res = await request(buildApp()).post("/v1/scratch/ping").send({});
    expect(res.status).toBe(400);
  });

  // The response is a second place the guarantee could leak, so it is asserted
  // on the wire and not only on what the database received.
  it("answers with tiles and never with coordinates", async () => {
    const res = await request(buildApp()).post("/v1/scratch/ping").send(CENTRE);

    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(String(CENTRE.lat));
    expect(wire).not.toContain(String(CENTRE.lng));
  });
});

describe("PUT /v1/scratch/opt-in", () => {
  it("turns collection on", async () => {
    const res = await request(buildApp()).put("/v1/scratch/opt-in").send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.optIn).toBe(true);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "me" },
      data: { scratchMapOptIn: true },
    });
  });

  // Switching it off stops collection and keeps the map: the tiles are the
  // person's own, and a toggle that silently deleted months of them would be a
  // worse surprise than one that stops collecting. Erasure is account deletion.
  it("keeps what was already uncovered when turned off", async () => {
    scratchFindUnique.mockResolvedValue({
      exploredTiles: ["u8vmxh", "u8vmxj"],
      exploredPercent: 0.0007,
      discoveredVenues: ["ChIJx"],
    });

    const res = await request(buildApp()).put("/v1/scratch/opt-in").send({ enabled: false });

    expect(res.body.optIn).toBe(false);
    expect(res.body.exploredTiles).toEqual(["u8vmxh", "u8vmxj"]);
    expect(scratchUpsert).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a boolean", async () => {
    const res = await request(buildApp()).put("/v1/scratch/opt-in").send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
