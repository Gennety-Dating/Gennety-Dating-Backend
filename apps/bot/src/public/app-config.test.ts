import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { appConfigRouter } from "./routes/app-config.js";

function buildApp() {
  const app = express();
  app.use("/v1/app", appConfigRouter);
  return app;
}

describe("GET /v1/app/config", () => {
  it("serves the pre-auth bootstrap payload without authentication", async () => {
    const res = await request(buildApp()).get("/v1/app/config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      features: {
        phoneAuth: expect.any(Boolean),
        tickets: expect.any(Boolean),
        coordination: expect.any(Boolean),
      },
    });
    // Kill switch defaults to null (no forced update) unless the env is set.
    expect(
      res.body.minSupportedIosVersion === null ||
        typeof res.body.minSupportedIosVersion === "string",
    ).toBe(true);
    expect(new Date(res.body.serverNow).getTime()).not.toBeNaN();
  });

  it("does not leak server-internal config keys", async () => {
    const res = await request(buildApp()).get("/v1/app/config");
    expect(Object.keys(res.body).sort()).toEqual([
      "features",
      "minSupportedIosVersion",
      "serverNow",
    ]);
  });
});
