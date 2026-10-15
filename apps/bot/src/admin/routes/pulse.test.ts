import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const READ_KEY = "r".repeat(40);

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    CUSTOM_EMOJI_ACCEPT_ID: "",
    CUSTOM_EMOJI_DECLINE_ID: "",
    MESSAGE_EFFECT_MATCH_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    ADMIN_API_KEY: "test-secret-key",
    ADMIN_READ_KEY: "r".repeat(40),
    ADMIN_PORT: 3100,
    ADMIN_DASHBOARD_ORIGIN: "*",
    ADMIN_TEST_TELEGRAM_IDS: "",
    CLIENT_EVENTS_ENABLED: true,
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    // Cache misses forever, so every request reaches the (mocked) builder.
    systemKnowledge: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

const b = vi.hoisted(() => ({
  buildBrief: vi.fn(),
  buildScreens: vi.fn(),
  buildScreenDetail: vi.fn(),
  buildJourneys: vi.fn(),
  buildJourney: vi.fn(),
  buildCatalog: vi.fn(),
  buildFunnels: vi.fn(),
  buildInsights: vi.fn(),
}));

vi.mock("../utils/pulse-read.js", () => ({
  ...b,
  isScreenKey: (raw: string) => /^[a-z0-9_]{1,32}$/.test(raw),
}));

const { app, readKeyAllows } = await import("../server.js");

const FULL = { Authorization: "Bearer test-secret-key" };
const READ = { Authorization: `Bearer ${READ_KEY}` };
const UUID = "0b8f6d0e-3f0a-4a51-9a59-2a9a1d3a6c11";
const body = { generatedAt: "2026-10-15T00:00:00.000Z", dataFreshness: {} };

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(b)) fn.mockResolvedValue(body);
});

describe("read-only key", () => {
  it("passes GET /admin/pulse/*", async () => {
    const res = await request(app).get("/admin/pulse/brief").set(READ);
    expect(res.status).toBe(200);
    expect(b.buildBrief).toHaveBeenCalledTimes(1);
  });

  it("passes the auth gate for GET /admin/analytics/*", async () => {
    // An unknown analytics path: the gate lets it through, Express answers 404.
    const res = await request(app).get("/admin/analytics/does-not-exist").set(READ);
    expect(res.status).toBe(404);
  });

  it("is refused everywhere else, and for any non-GET", async () => {
    expect((await request(app).get("/admin/users").set(READ)).status).toBe(403);
    expect((await request(app).get("/admin/stats").set(READ)).status).toBe(403);
    expect((await request(app).post("/admin/pulse/brief").set(READ)).status).toBe(403);
    expect((await request(app).patch("/admin/analytics/anything").set(READ)).status).toBe(403);
  });

  it("the full key still works everywhere it did, and a wrong key is 401", async () => {
    expect((await request(app).get("/admin/pulse/brief").set(FULL)).status).toBe(200);
    expect((await request(app).get("/admin/pulse/brief").set({ Authorization: "Bearer nope" })).status).toBe(401);
    expect((await request(app).get("/admin/pulse/brief")).status).toBe(401);
  });

  it("path guard refuses traversal and odd encodings", () => {
    expect(readKeyAllows("GET", "/admin/pulse/brief")).toBe(true);
    expect(readKeyAllows("GET", "/admin/analytics/virality/summary")).toBe(true);
    expect(readKeyAllows("HEAD", "/admin/pulse/brief")).toBe(false);
    expect(readKeyAllows("GET", "/admin/pulse/../users")).toBe(false);
    expect(readKeyAllows("GET", "/admin/pulse/%2e%2e/users")).toBe(false);
    expect(readKeyAllows("GET", "/admin/pulse//x")).toBe(false);
    expect(readKeyAllows("GET", "/admin/pulse")).toBe(false);
    expect(readKeyAllows("GET", "/admin/pulsex/brief")).toBe(false);
    expect(readKeyAllows("GET", "/admin/users/x")).toBe(false);
  });

  it("never reads the weekly matches report — it names real pairs", () => {
    expect(readKeyAllows("GET", "/admin/analytics/weekly-matches")).toBe(false);
    expect(readKeyAllows("GET", "/admin/analytics/Weekly-Matches")).toBe(false);
    expect(readKeyAllows("GET", "/admin/analytics/founder-weekly")).toBe(false);
    expect(readKeyAllows("GET", "/admin/analytics/onboarding-funnel")).toBe(true);
  });
});

describe("/admin/pulse routes", () => {
  it("screens/:screen validates the key format", async () => {
    expect((await request(app).get("/admin/pulse/screens/Bad-Key").set(FULL)).status).toBe(400);
    const ok = await request(app).get("/admin/pulse/screens/city").set(FULL);
    expect(ok.status).toBe(200);
    expect(b.buildScreenDetail).toHaveBeenCalledWith("city");
  });

  it("journeys clamps limit and reads stuck=1", async () => {
    await request(app).get("/admin/pulse/journeys?stuck=1&limit=500").set(READ);
    expect(b.buildJourneys).toHaveBeenCalledWith({ stuckOnly: true, limit: 50 });
    await request(app).get("/admin/pulse/journeys?limit=abc").set(READ);
    expect(b.buildJourneys).toHaveBeenLastCalledWith({ stuckOnly: false, limit: 20 });
  });

  it("journeys/:userId checks the uuid and 404s an unknown person", async () => {
    expect((await request(app).get("/admin/pulse/journeys/123").set(READ)).status).toBe(400);
    b.buildJourney.mockResolvedValueOnce(null);
    expect((await request(app).get(`/admin/pulse/journeys/${UUID}`).set(READ)).status).toBe(404);
    const ok = await request(app).get(`/admin/pulse/journeys/${UUID}`).set(READ);
    expect(ok.status).toBe(200);
    expect(b.buildJourney).toHaveBeenLastCalledWith(UUID);
  });

  it("insights accepts open|all only", async () => {
    expect((await request(app).get("/admin/pulse/insights?status=closed").set(READ)).status).toBe(400);
    await request(app).get("/admin/pulse/insights").set(READ);
    expect(b.buildInsights).toHaveBeenLastCalledWith("open");
    await request(app).get("/admin/pulse/insights?status=all").set(READ);
    expect(b.buildInsights).toHaveBeenLastCalledWith("all");
  });

  it("catalog and funnels answer, and a builder failure is a 500", async () => {
    expect((await request(app).get("/admin/pulse/catalog").set(READ)).status).toBe(200);
    expect((await request(app).get("/admin/pulse/funnels").set(READ)).status).toBe(200);
    b.buildScreens.mockRejectedValueOnce(new Error("db down"));
    expect((await request(app).get("/admin/pulse/screens").set(READ)).status).toBe(500);
  });
});
