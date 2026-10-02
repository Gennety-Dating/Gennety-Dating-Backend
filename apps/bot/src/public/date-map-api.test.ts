import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindMany = vi.fn();
const curatedFindMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findMany: matchFindMany },
    curatedVenue: { findMany: curatedFindMany },
  },
}));

vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "me";
    next();
  },
}));

const { dateMapRouter } = await import("./routes/date-map.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/date-map", dateMapRouter);
  return app;
}

beforeEach(() => {
  matchFindMany.mockReset().mockResolvedValue([]);
  curatedFindMany.mockReset().mockResolvedValue([]);
});

describe("GET /v1/date-map", () => {
  it("answers an empty map for someone with no confirmed date", async () => {
    const res = await request(buildApp()).get("/v1/date-map");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ confirmedDates: 0, places: [], vibes: [] });
  });

  it("answers places with the venue's point and an ISO date, and no partner", async () => {
    matchFindMany.mockResolvedValue([
      {
        agreedTime: new Date("2026-09-20T17:00:00Z"),
        venueName: "Takava",
        venuePlaceId: "p-takava",
        venueLat: 50.45,
        venueLng: 30.52,
        venueMidpointLat: 50.44,
      },
    ]);
    curatedFindMany.mockResolvedValue([{ placeId: "p-takava", vibeTags: ["coffee"] }]);

    const res = await request(buildApp()).get("/v1/date-map");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      confirmedDates: 1,
      places: [
        {
          placeId: "p-takava",
          name: "Takava",
          lat: 50.45,
          lng: 30.52,
          visits: 1,
          lastDateAt: "2026-09-20T17:00:00.000Z",
          experiences: ["coffee_treats"],
        },
      ],
      vibes: [{ experience: "coffee_treats", dates: 1 }],
    });
    // The query never selects who the date was with.
    const select = matchFindMany.mock.calls[0]![0].select;
    expect(Object.keys(select)).not.toContain("userAId");
    expect(Object.keys(select)).not.toContain("userBId");
  });
});
