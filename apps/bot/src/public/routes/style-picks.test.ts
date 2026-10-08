import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = vi.hoisted(() => ({
  STYLE_PICKS_ENABLED: true,
  STYLE_PICKS_FREQUENT_PLACES_ENABLED: false,
  JWT_SECRET: "test-jwt-secret-value-long-enough",
  BOT_TOKEN: "123456:test-bot-token",
  PUBLIC_BASE_URL: "https://api.example",
  LLM_TOKEN_BUDGET_ENABLED: false,
}));
vi.mock("../../config.js", () => ({ env }));

const h = vi.hoisted(() => ({
  getStylePicks: vi.fn(),
  findUnique: vi.fn(),
  createClick: vi.fn(),
}));
vi.mock("../../services/style-picks/service.js", () => ({ getStylePicks: h.getStylePicks }));
vi.mock("@gennety/db", () => ({
  prisma: {
    styleProduct: { findUnique: h.findUnique },
    styleClick: { create: h.createClick },
  },
}));

const { createStyleOutRouter, createStylePicksRouter } = await import("./style-picks.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");
const { styleOutUrl } = await import("../../services/style-picks/out-link.js");

function buildApp() {
  const app = express();
  app.use("/v1/me/style-picks", createStylePicksRouter());
  app.use("/v1/style", createStyleOutRouter());
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

const PRODUCT = {
  id: "jo-malone-wood-sage-sea-salt",
  category: "scent",
  brand: "Jo Malone London",
  name: "Wood Sage & Sea Salt Cologne",
  gender: "unisex",
  priceTier: 2,
  priceEUR: 76,
  notes: "sea salt and sage",
  tags: ["fresh"],
  url: "https://www.breuninger.com/de/p/",
  urlUA: "https://makeup.com.ua/product/202125/",
  imageUrl: null,
  sponsored: false,
  affiliateParams: null,
  badges: [],
  active: true,
};

const RESPONSE = {
  generatedAt: "2026-10-08T12:00:00.000Z",
  language: "en",
  basis: ["calm evenings"],
  picks: [
    {
      id: PRODUCT.id,
      category: "scent",
      brand: PRODUCT.brand,
      name: PRODUCT.name,
      reason: "Fresh for your daytime walks.",
      signals: ["park walks"],
      priceTier: 2,
      imageUrl: null,
      outUrl: "https://api.example/v1/style/out/x",
      sponsored: false,
      badges: [{ kind: "forYou" }],
    },
  ],
};

beforeEach(() => {
  env.STYLE_PICKS_ENABLED = true;
  h.getStylePicks.mockResolvedValue(RESPONSE);
  h.findUnique.mockResolvedValue(PRODUCT);
  h.createClick.mockResolvedValue({});
});

describe("GET /v1/me/style-picks", () => {
  it("needs a JWT", async () => {
    expect((await request(buildApp()).get("/v1/me/style-picks")).status).toBe(401);
  });

  it("answers 204 while the flag is off, without generating anything", async () => {
    env.STYLE_PICKS_ENABLED = false;
    const res = await request(buildApp()).get("/v1/me/style-picks").set(auth());
    expect(res.status).toBe(204);
    expect(h.getStylePicks).not.toHaveBeenCalled();
  });

  it("answers 204 for a thin profile or a failure with nothing cached", async () => {
    h.getStylePicks.mockResolvedValue(null);
    expect((await request(buildApp()).get("/v1/me/style-picks").set(auth())).status).toBe(204);
    h.getStylePicks.mockRejectedValue(new Error("boom"));
    expect((await request(buildApp()).get("/v1/me/style-picks").set(auth())).status).toBe(204);
  });

  it("serves the selection", async () => {
    const res = await request(buildApp()).get("/v1/me/style-picks").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESPONSE);
    expect(h.getStylePicks).toHaveBeenCalledWith(USER_ID);
  });
});

describe("GET /v1/style/out/{itemId}", () => {
  function pathOf(url: string): string {
    const u = new URL(url);
    return u.pathname + u.search;
  }

  it("logs a signed click and redirects with UTM tags", async () => {
    const res = await request(buildApp()).get(pathOf(styleOutUrl(USER_ID, PRODUCT.id, "en")));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location!);
    expect(location.host).toBe("www.breuninger.com");
    expect(location.searchParams.get("utm_campaign")).toBe("style_picks");
    expect(location.searchParams.get("utm_content")).toBe("scent");
    expect(h.createClick).toHaveBeenCalledWith({ data: { userId: USER_ID, itemId: PRODUCT.id, category: "scent" } });
  });

  it("sends a uk link to the Ukrainian shop", async () => {
    const res = await request(buildApp()).get(pathOf(styleOutUrl(USER_ID, PRODUCT.id, "uk")));
    expect(new URL(res.headers.location!).host).toBe("makeup.com.ua");
  });

  it("still redirects a tampered or unsigned link, but logs nobody", async () => {
    const tampered = pathOf(styleOutUrl(USER_ID, PRODUCT.id, "en")).replace(
      USER_ID,
      "22222222-2222-4222-8222-222222222222",
    );
    expect((await request(buildApp()).get(tampered)).status).toBe(302);
    expect((await request(buildApp()).get(`/v1/style/out/${PRODUCT.id}`)).status).toBe(302);
    expect(h.createClick).not.toHaveBeenCalled();
  });

  it("redirects even when the click log fails", async () => {
    h.createClick.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).get(pathOf(styleOutUrl(USER_ID, PRODUCT.id, "en")));
    expect(res.status).toBe(302);
  });

  it("404s an unknown or malformed item id", async () => {
    h.findUnique.mockResolvedValue(null);
    expect((await request(buildApp()).get("/v1/style/out/nope")).status).toBe(404);
    expect((await request(buildApp()).get("/v1/style/out/..%2Fadmin")).status).toBe(404);
  });
});
