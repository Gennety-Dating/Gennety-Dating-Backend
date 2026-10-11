/**
 * Audit C-24: the Bump and Radar routers share `/v1/dates`, and the Bump's
 * router-wide `use(canvasLimiter)` ran on every radar ping on its way through,
 * so one ping cost the person two units of their canvas budget. Mounted
 * exactly as `server.ts` mounts them, one ping must cost one.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: vi.fn() }, profile: { findUnique: vi.fn() } },
}));

let caller = "me";
vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = caller;
    next();
  },
}));

const { dateBumpRouter } = await import("./routes/date-bump.js");
const { dateRadarRouter } = await import("./routes/date-radar.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/dates", dateBumpRouter);
  app.use("/v1/dates", dateRadarRouter);
  return app;
}

function remaining(header: string | undefined): number {
  const m = /remaining=(\d+)/.exec(header ?? "");
  return m ? Number(m[1]) : Number.NaN;
}

describe("canvas limiter on /v1/dates", () => {
  it("charges a radar ping once, not once per router it passes", async () => {
    caller = "radar-once";
    // A non-UUID id is refused by the radar route itself, after the limiter
    // and before any database read.
    const res = await request(buildApp()).post("/v1/dates/nope/proximity").send({});
    expect(res.status).toBe(400);
    expect(remaining(res.headers.ratelimit)).toBe(89);
  });

  it("still meters the bump itself", async () => {
    caller = "bump-once";
    const res = await request(buildApp()).post("/v1/dates/nope/bump").send({});
    expect(remaining(res.headers.ratelimit)).toBe(89);
  });
});
