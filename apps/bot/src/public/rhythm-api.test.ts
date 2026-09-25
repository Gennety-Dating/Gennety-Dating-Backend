/**
 * HTTP boundary of `/v1/me/rhythm` (Tempo Sync). Prisma is mocked; the JWT
 * rail is mocked the way `account-status.test.ts` mocks it.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rhythmFindUnique = vi.fn();
const rhythmFindFirst = vi.fn();
const rhythmFindMany = vi.fn();
const rhythmUpsert = vi.fn();
const rhythmDeleteMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    userRhythmProfile: {
      findUnique: (...a: unknown[]) => rhythmFindUnique(...a),
      findFirst: (...a: unknown[]) => rhythmFindFirst(...a),
      findMany: (...a: unknown[]) => rhythmFindMany(...a),
      upsert: (...a: unknown[]) => rhythmUpsert(...a),
      deleteMany: (...a: unknown[]) => rhythmDeleteMany(...a),
    },
  },
}));

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "u-1";
    next();
  },
}));

const { rhythmRouter } = await import("./routes/rhythm.js");
const { loadRhythmTags } = await import("../services/rhythm/store.js");
const { env } = await import("../config.js");

const mutableEnv = env as unknown as Record<string, unknown>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/rhythm", rhythmRouter);
  return app;
}

const BODY = {
  algoVersion: 1,
  windowDays: 28,
  coverageDays: 20,
  activity: "moderate",
  chronotype: "late",
  source: "healthkit",
  consentVersion: "2026-09-25",
};

const SYNCED = new Date("2026-09-25T10:00:00.000Z");
const CONSENTED = new Date("2026-09-20T10:00:00.000Z");

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    activity: "moderate",
    chronotype: "late",
    coverageDays: 20,
    syncedAt: SYNCED,
    consentedAt: CONSENTED,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.TEMPO_SYNC_ENABLED = true;
});

afterEach(() => {
  mutableEnv.TEMPO_SYNC_ENABLED = false;
});

describe("/v1/me/rhythm — the switch", () => {
  it("does not exist while Tempo Sync is off", async () => {
    mutableEnv.TEMPO_SYNC_ENABLED = false;
    const app = buildApp();
    expect((await request(app).get("/v1/me/rhythm")).status).toBe(404);
    expect((await request(app).put("/v1/me/rhythm").send(BODY)).status).toBe(404);
    expect((await request(app).delete("/v1/me/rhythm")).status).toBe(404);
    expect(rhythmUpsert).not.toHaveBeenCalled();
    expect(rhythmDeleteMany).not.toHaveBeenCalled();
  });
});

describe("GET /v1/me/rhythm", () => {
  it("returns the owner's own fresh profile", async () => {
    rhythmFindFirst.mockResolvedValue(storedRow());
    const res = await request(buildApp()).get("/v1/me/rhythm");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      profile: {
        activity: "moderate",
        chronotype: "late",
        coverageDays: 20,
        syncedAt: SYNCED.toISOString(),
        consentedAt: CONSENTED.toISOString(),
      },
    });
    // Stale rows are filtered in the query, not after it.
    const where = rhythmFindFirst.mock.calls[0]![0].where;
    expect(where.userId).toBe("u-1");
    expect(where.syncedAt.gte).toBeInstanceOf(Date);
  });

  it("returns null when there is nothing (or nothing fresh)", async () => {
    rhythmFindFirst.mockResolvedValue(null);
    const res = await request(buildApp()).get("/v1/me/rhythm");
    expect(res.body).toEqual({ profile: null });
  });
});

describe("PUT /v1/me/rhythm", () => {
  it("stores a valid upload and stamps consent on first sync", async () => {
    rhythmFindUnique.mockResolvedValue(null);
    rhythmUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) =>
      storedRow({ syncedAt: args.create.syncedAt, consentedAt: args.create.consentedAt }),
    );
    const res = await request(buildApp()).put("/v1/me/rhythm").send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const args = rhythmUpsert.mock.calls[0]![0];
    expect(args.where).toEqual({ userId: "u-1" });
    expect(args.create).toMatchObject({
      userId: "u-1",
      activity: "moderate",
      chronotype: "late",
      coverageDays: 20,
      algoVersion: 1,
      source: "healthkit",
      consentVersion: "2026-09-25",
    });
    // First consent and first sync are the same moment.
    expect(args.create.consentedAt).toEqual(args.create.syncedAt);
  });

  it("keeps the original consent time on a re-sync of the same version", async () => {
    rhythmFindUnique.mockResolvedValue({ consentVersion: "2026-09-25", consentedAt: CONSENTED });
    rhythmUpsert.mockResolvedValue(storedRow());
    await request(buildApp()).put("/v1/me/rhythm").send(BODY);
    const args = rhythmUpsert.mock.calls[0]![0];
    expect(args.update.consentedAt).toEqual(CONSENTED);
    expect(args.update.syncedAt.getTime()).toBeGreaterThan(CONSENTED.getTime());
  });

  it("refuses a body carrying anything beyond the two tags", async () => {
    const res = await request(buildApp())
      .put("/v1/me/rhythm")
      .send({ ...BODY, medianSteps: 8123, sleepMinutes: 402 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown field: medianSteps, sleepMinutes");
    expect(rhythmUpsert).not.toHaveBeenCalled();
  });

  it("refuses too little coverage — the client must not send it at all", async () => {
    const res = await request(buildApp()).put("/v1/me/rhythm").send({ ...BODY, coverageDays: 6 });
    expect(res.status).toBe(400);
    expect(rhythmUpsert).not.toHaveBeenCalled();
  });
});

describe("DELETE /v1/me/rhythm", () => {
  it("forgets the row and answers 204 whether or not one existed", async () => {
    rhythmDeleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const app = buildApp();
    expect((await request(app).delete("/v1/me/rhythm")).status).toBe(204);
    expect((await request(app).delete("/v1/me/rhythm")).status).toBe(204);
    expect(rhythmDeleteMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
  });
});

describe("loadRhythmTags — the scorers' read", () => {
  it("returns tags only, and skips unparseable rows", async () => {
    rhythmFindMany.mockResolvedValue([
      { userId: "a", activity: "active", chronotype: "early" },
      { userId: "b", activity: "calm", chronotype: null },
      { userId: "c", activity: "unknown", chronotype: null },
    ]);
    const tags = await loadRhythmTags(["a", "b", "c", "d"]);
    expect([...tags.entries()]).toEqual([
      ["a", { activity: "active", chronotype: "early" }],
      ["b", { activity: "calm", chronotype: null }],
    ]);
    const args = rhythmFindMany.mock.calls[0]![0];
    expect(args.select).toEqual({ userId: true, activity: true, chronotype: true });
  });

  it("reads nothing at all while the switch is off", async () => {
    mutableEnv.TEMPO_SYNC_ENABLED = false;
    const tags = await loadRhythmTags(["a"]);
    expect(tags.size).toBe(0);
    expect(rhythmFindMany).not.toHaveBeenCalled();
  });
});
