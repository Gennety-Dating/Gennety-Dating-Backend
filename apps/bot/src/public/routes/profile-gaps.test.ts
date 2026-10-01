import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../../config.js", () => ({ env: { JWT_SECRET, BOT_TOKEN: "123456:test-bot-token" } }));

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../services/profile-gaps.js", () => ({ loadProfileGaps: h.load }));

const { profileGapsRouter } = await import("./profile-gaps.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/profile-gaps", profileGapsRouter);
  return app;
}

function auth(): { Authorization: string } {
  const token = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  h.load.mockReset();
});

describe("GET /v1/me/profile-gaps", () => {
  it("needs a JWT", async () => {
    expect((await request(buildApp()).get("/v1/me/profile-gaps")).status).toBe(401);
    const bad = await request(buildApp())
      .get("/v1/me/profile-gaps")
      .set({ Authorization: "Bearer not-a-token" });
    expect(bad.status).toBe(401);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("returns the caller's gaps as the service ordered them", async () => {
    const gaps = [
      { kind: "video", reward: "ticket" },
      { kind: "photos", remaining: 2 },
      { kind: "major" },
    ];
    h.load.mockResolvedValue(gaps);

    const res = await request(buildApp()).get("/v1/me/profile-gaps").set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gaps });
    expect(h.load).toHaveBeenCalledWith(USER_ID);
  });

  it("answers an empty list for a finished profile", async () => {
    h.load.mockResolvedValue([]);
    const res = await request(buildApp()).get("/v1/me/profile-gaps").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gaps: [] });
  });

  it("404s for a token whose user no longer exists", async () => {
    h.load.mockResolvedValue(null);
    const res = await request(buildApp()).get("/v1/me/profile-gaps").set(auth());
    expect(res.status).toBe(404);
  });
});
