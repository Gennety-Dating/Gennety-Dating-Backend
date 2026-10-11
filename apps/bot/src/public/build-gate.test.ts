import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = { MIN_IOS_BUILD: 0 };
vi.mock("../config.js", () => ({ env: envMock }));

const { requireMinBuild } = await import("./build-gate.js");

/** C-23 / contract decision #3: `X-Gennety-Build` below `MIN_IOS_BUILD` → 426. */
function buildApp() {
  const app = express();
  app.use("/v1", requireMinBuild);
  app.get("/v1/me", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  envMock.MIN_IOS_BUILD = 0;
});

describe("requireMinBuild", () => {
  it("is off at 0 whatever the header says", async () => {
    const res = await request(buildApp()).get("/v1/me").set("X-Gennety-Build", "1");
    expect(res.status).toBe(200);
  });

  it("refuses a build below the floor with 426 update_required", async () => {
    envMock.MIN_IOS_BUILD = 120;
    const res = await request(buildApp()).get("/v1/me").set("X-Gennety-Build", "119");
    expect(res.status).toBe(426);
    expect(res.body).toEqual({ error: "update_required" });
  });

  it("passes the floor itself and anything above", async () => {
    envMock.MIN_IOS_BUILD = 120;
    expect((await request(buildApp()).get("/v1/me").set("X-Gennety-Build", "120")).status).toBe(200);
    expect((await request(buildApp()).get("/v1/me").set("X-Gennety-Build", "300")).status).toBe(200);
  });

  it("passes a request without the header, or with a non-integer one", async () => {
    envMock.MIN_IOS_BUILD = 120;
    expect((await request(buildApp()).get("/v1/me")).status).toBe(200);
    expect((await request(buildApp()).get("/v1/me").set("X-Gennety-Build", "1.2.3")).status).toBe(200);
  });
});
