import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: { liveActivityToken: { upsert, deleteMany } },
}));

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "user-1";
    next();
  },
}));

const { liveActivityRouter } = await import("./routes/live-activity.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/live-activity-token", liveActivityRouter);
  return app;
}

beforeEach(() => {
  upsert.mockReset().mockResolvedValue({});
  deleteMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("/v1/me/live-activity-token", () => {
  it("upserts a token per (user, activityType, kind)", async () => {
    const res = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "date_day", kind: "update", token: "tok-1", matchId: "m-1" });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith({
      where: {
        userId_activityType_kind: {
          userId: "user-1",
          activityType: "date_day",
          kind: "update",
        },
      },
      update: { token: "tok-1", matchId: "m-1" },
      create: {
        userId: "user-1",
        activityType: "date_day",
        kind: "update",
        token: "tok-1",
        matchId: "m-1",
      },
    });
  });

  // Audit A13-L12: the token names this install. An account that signed in on
  // the same phone before must stop driving Live Activities on its lock screen.
  it("takes the token away from any other account before registering it", async () => {
    const res = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "match_decision", kind: "start", token: "tok-shared" });

    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { token: "tok-shared", userId: { not: "user-1" } },
    });
    expect(deleteMany.mock.invocationCallOrder[0]!).toBeLessThan(
      upsert.mock.invocationCallOrder[0]!,
    );
  });

  it("accepts the venue-change card's tokens (decision 2026-09-22)", async () => {
    const start = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "venue_change", kind: "start", token: "tok-start" });
    expect(start.status).toBe(200);
    const update = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "venue_change", kind: "update", token: "tok-upd", matchId: "m-1" });
    expect(update.status).toBe(200);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: {
          userId: "user-1",
          activityType: "venue_change",
          kind: "update",
          token: "tok-upd",
          matchId: "m-1",
        },
      }),
    );
    const del = await request(buildApp()).delete("/v1/me/live-activity-token/venue_change/update");
    expect(del.status).toBe(204);
  });

  it("accepts the time-agreement card's tokens (decision 2026-09-23)", async () => {
    const start = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "time_agreement", kind: "start", token: "tok-start" });
    expect(start.status).toBe(200);
    const update = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "time_agreement", kind: "update", token: "tok-upd", matchId: "m-1" });
    expect(update.status).toBe(200);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: {
          userId: "user-1",
          activityType: "time_agreement",
          kind: "update",
          token: "tok-upd",
          matchId: "m-1",
        },
      }),
    );
    const del = await request(buildApp()).delete("/v1/me/live-activity-token/time_agreement/start");
    expect(del.status).toBe(204);
  });

  it("rejects unknown activity types and kinds", async () => {
    const res = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "party", kind: "update", token: "tok" });
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized token", async () => {
    const res = await request(buildApp())
      .post("/v1/me/live-activity-token")
      .send({ activityType: "date_day", kind: "start", token: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("deletes the registration when the activity ends locally", async () => {
    const res = await request(buildApp()).delete(
      "/v1/me/live-activity-token/date_day/update",
    );
    expect(res.status).toBe(204);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", activityType: "date_day", kind: "update" },
    });
  });
});
