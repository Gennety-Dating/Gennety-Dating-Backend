import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * The heavy admin loaders keep at most `ADMIN_DB_CONCURRENCY` queries out at
 * once (`admin/utils/db-gate.ts`). Every query in this file's fake database
 * takes a real timer tick, so a loader that still fanned out in one
 * `Promise.all` would show up here as more than three in flight.
 */

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    ADMIN_API_KEY: "test-secret-key",
    ADMIN_PORT: 3100,
    ADMIN_DASHBOARD_ORIGIN: "*",
  },
}));

const { tracker } = vi.hoisted(() => ({
  tracker: {
    inFlight: 0,
    maxInFlight: 0,
    queries: 0,
    /** A query started while the five-query payer loader was running. */
    overlappedPayerLoad: false,
    payerLoads: 0,
    payerRunning: false,
  },
}));

vi.mock("@gennety/db", () => {
  const settle = <T>(value: T): Promise<T> => {
    if (tracker.payerRunning) tracker.overlappedPayerLoad = true;
    tracker.queries += 1;
    tracker.inFlight += 1;
    tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
    return new Promise((resolve) =>
      setTimeout(() => {
        tracker.inFlight -= 1;
        resolve(value);
      }, 2),
    );
  };
  const answerFor = (method: string): unknown => {
    if (method === "count") return 0;
    if (method === "findUnique" || method === "findFirst") return null;
    if (method === "upsert" || method === "update" || method === "create") {
      return { updatedAt: new Date() };
    }
    return [];
  };
  const model = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method === "string" && method !== "then"
            ? () => settle(answerFor(method))
            : undefined,
      },
    );
  const models = new Map<string, unknown>();
  const prisma = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "then" || typeof key !== "string") return undefined;
        if (key === "$queryRaw") return () => settle([]);
        if (!models.has(key)) models.set(key, model());
        return models.get(key);
      },
    },
  );
  return { prisma };
});

vi.mock("../../services/verification-pipeline.js", () => ({
  runFaceMatchVerificationDefault: vi.fn(),
}));

vi.mock("../../services/storage.js", () => ({
  downloadProfileImage: vi.fn(),
  downloadChatImage: vi.fn(),
  downloadTelegramFile: vi.fn(),
}));

vi.mock("../../services/purchases.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/purchases.js")>(
    "../../services/purchases.js",
  );
  return {
    ...actual,
    // The real one runs five queries in parallel; it is modelled as exactly
    // that, so "runs alone" is something this test can see.
    loadPayerIndex: vi.fn(() => {
      if (tracker.inFlight > 0) tracker.overlappedPayerLoad = true;
      tracker.payerLoads += 1;
      tracker.payerRunning = true;
      tracker.inFlight += 5;
      tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
      return new Promise((resolve) =>
        setTimeout(() => {
          tracker.inFlight -= 5;
          tracker.payerRunning = false;
          resolve({ byUser: new Map(), truncated: false });
        }, 2),
      );
    }),
  };
});

import { app } from "../server.js";

const get = (url: string) =>
  request(app).get(url).set("Authorization", "Bearer test-secret-key");

beforeEach(() => {
  tracker.inFlight = 0;
  tracker.maxInFlight = 0;
  tracker.queries = 0;
  tracker.overlappedPayerLoad = false;
  tracker.payerLoads = 0;
  tracker.payerRunning = false;
});

describe("admin loaders under the DB gate", () => {
  it("/admin/dashboard keeps at most 3 queries out, and the payer index runs alone", async () => {
    const res = await get("/admin/dashboard");

    expect(res.status).toBe(200);
    expect(tracker.queries).toBeGreaterThan(15);
    expect(tracker.payerLoads).toBe(1);
    expect(tracker.overlappedPayerLoad).toBe(false);
    // Three single queries, or the payer loader's own five on its own.
    expect(tracker.maxInFlight).toBeLessThanOrEqual(5);
  });

  it("/admin/stats never has more than 3 queries out", async () => {
    const res = await get("/admin/stats");

    expect(res.status).toBe(200);
    expect(tracker.queries).toBeGreaterThan(10);
    expect(tracker.maxInFlight).toBe(3);
  });

  it("a founder-digest miss (~34 queries) runs three at a time and each payer load alone", async () => {
    const res = await get("/admin/analytics/founder-digest?fresh=1");

    expect(res.status).toBe(200);
    expect(tracker.payerLoads).toBe(3);
    expect(tracker.overlappedPayerLoad).toBe(false);
    expect(tracker.maxInFlight).toBeLessThanOrEqual(5);
  });

  it("two dashboards opened together share the same three slots", async () => {
    const [a, b] = await Promise.all([get("/admin/stats"), get("/admin/stats")]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(tracker.maxInFlight).toBe(3);
  });
});
