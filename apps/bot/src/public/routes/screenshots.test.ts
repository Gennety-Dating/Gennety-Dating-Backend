import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

const env = vi.hoisted(() => ({
  SCREENSHOT_LIBRARY_ENABLED: false,
  JWT_SECRET: "test-jwt-secret-value-long-enough",
  BOT_TOKEN: "123456:test-bot-token",
  PUBLIC_BASE_URL: "https://api.example",
  LLM_TOKEN_BUDGET_ENABLED: false,
}));
vi.mock("../../config.js", () => ({ env }));

const lib = vi.hoisted(() => {
  class ScreenshotLibraryError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    ScreenshotLibraryError,
    libraryView: vi.fn(async () => ({ status: "active", counts: { total: 1 } })),
    connectLibrary: vi.fn(async () => ({})),
    setLibraryPaused: vi.fn(async () => ({})),
    disconnectLibrary: vi.fn(async () => ({ status: "off", counts: { deleting: 1 } })),
    reconcile: vi.fn(async () => ({ removed: 0 })),
    reserveUpload: vi.fn(async () => ({})),
    commitUpload: vi.fn(async () => ({})),
    listItems: vi.fn(async () => ({ items: [], nextBefore: null })),
    readItem: vi.fn(async () => ({ id: ITEM_ID })),
    deleteItem: vi.fn(async () => undefined),
    searchItems: vi.fn(async () => []),
  };
});
vi.mock("../../services/screenshot-library.js", () => lib);

const { createScreenshotsRouter } = await import("./screenshots.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function app() {
  const server = express();
  server.use(express.json());
  server.use("/v1/me/screenshots", createScreenshotsRouter());
  return server;
}

function auth(): { Authorization: string } {
  const token = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: "15m" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  env.SCREENSHOT_LIBRARY_ENABLED = false;
  vi.clearAllMocks();
});

describe("screenshot routes with the flag off (audit F-01)", () => {
  it("still disconnect-and-delete the whole library", async () => {
    const res = await request(app()).delete("/v1/me/screenshots/library").set(auth());
    expect(res.status).toBe(202);
    expect(lib.disconnectLibrary).toHaveBeenCalledWith(USER_ID);
  });

  it("still delete one screenshot", async () => {
    const res = await request(app()).delete(`/v1/me/screenshots/${ITEM_ID}`).set(auth());
    expect(res.status).toBe(204);
    expect(lib.deleteItem).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it("still show the state, the list and one item, so the person can see what to delete", async () => {
    const a = app();
    expect((await request(a).get("/v1/me/screenshots/library").set(auth())).status).toBe(200);
    expect((await request(a).get("/v1/me/screenshots").set(auth())).status).toBe(200);
    expect((await request(a).get(`/v1/me/screenshots/${ITEM_ID}`).set(auth())).status).toBe(200);
  });

  it("refuse connecting, uploading, reconciling and the paid search", async () => {
    const a = app();
    const calls = [
      request(a).put("/v1/me/screenshots/library").set(auth()).send({ consentVersion: "x", autoImport: true, rangeDays: null }),
      request(a).patch("/v1/me/screenshots/library").set(auth()).send({ paused: false }),
      request(a).post("/v1/me/screenshots/library/reconcile").set(auth()).send({ generation: 1, removedSourceKeys: [] }),
      request(a).post("/v1/me/screenshots/uploads").set(auth()).send({}),
      request(a).post(`/v1/me/screenshots/${ITEM_ID}/commit`).set(auth()).send({ generation: 1 }),
      request(a).get("/v1/me/screenshots?q=wine").set(auth()),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("feature-disabled");
    }
    expect(lib.connectLibrary).not.toHaveBeenCalled();
    expect(lib.searchItems).not.toHaveBeenCalled();
  });

  it("still need a token for what stays open", async () => {
    expect((await request(app()).delete("/v1/me/screenshots/library")).status).toBe(401);
  });
});

describe("screenshot routes with the flag on", () => {
  it("serve connecting as before", async () => {
    env.SCREENSHOT_LIBRARY_ENABLED = true;
    const res = await request(app()).put("/v1/me/screenshots/library").set(auth()).send({ consentVersion: "x", autoImport: true, rangeDays: null });
    expect(res.status).toBe(200);
  });
});
