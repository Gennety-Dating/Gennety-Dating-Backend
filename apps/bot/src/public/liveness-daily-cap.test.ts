/**
 * Audit B-10: `selfieLimiter` was declared and never mounted, so the only
 * bound on paid AWS Face Liveness sessions was a per-minute burst limit.
 * These tests pin the daily cap itself and that both mint routes carry it.
 */
import express, { type Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("./server.js", () => ({ getBotApi: vi.fn(() => null) }));

const { selfieLimiter } = await import("./rate-limit.js");
const { verificationRouter } = await import("./routes/verification.js");
const { createVerificationMiniAppRouter } = await import("./routes/verification-mini-app.js");

type Layer = { route?: { path: string; stack: Array<{ handle: unknown }> } };

function routeHandlers(router: Router, path: string): unknown[] {
  const layer = (router.stack as unknown as Layer[]).find((l) => l.route?.path === path);
  return layer?.route?.stack.map((s) => s.handle) ?? [];
}

describe("selfieLimiter (B-10)", () => {
  it("caps one person at 10 liveness mints a day, per person", async () => {
    const app = express();
    app.use((req, _res, next) => {
      const user = req.get("x-test-user");
      if (user) req.userId = user;
      next();
    });
    app.get("/mint", selfieLimiter, (_req, res) => {
      res.json({ ok: true });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await request(app).get("/mint").set("x-test-user", "cap-user-a")).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);

    // Someone else behind the same address keeps their own budget.
    const other = await request(app).get("/mint").set("x-test-user", "cap-user-b");
    expect(other.status).toBe(200);
  });

  it("is mounted on both session-mint routes", () => {
    expect(routeHandlers(verificationRouter, "/native-init")).toContain(selfieLimiter);
    const miniApp = createVerificationMiniAppRouter({} as never);
    expect(routeHandlers(miniApp, "/init")).toContain(selfieLimiter);
  });
});
