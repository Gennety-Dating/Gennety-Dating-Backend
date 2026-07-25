import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    profile: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../services/profiler.js", () => ({
  startProfilerBatch: vi.fn().mockResolvedValue("sent"),
  expireStalledProfilerQuestion: vi.fn().mockResolvedValue(true),
  hasActiveDatePlanning: vi.fn().mockResolvedValue(false),
}));

import { prisma } from "@gennety/db";
import { profilerTick } from "./profiler.js";
import {
  startProfilerBatch,
  expireStalledProfilerQuestion,
  hasActiveDatePlanning,
} from "../services/profiler.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFindMany = (prisma.profile as unknown as { findMany: MockFn }).findMany;
const mUpdate = (prisma.profile as unknown as { update: MockFn }).update;
const mStart = startProfilerBatch as unknown as MockFn;
const mExpire = expireStalledProfilerQuestion as unknown as MockFn;
const mPlanning = hasActiveDatePlanning as unknown as MockFn;

const api = {} as never;
// Local 10:00 in Kyiv — outside quiet hours, so nothing is deferred for that.
const NOW = new Date("2026-06-10T07:00:00Z");

/** findMany is called in a fixed order: seed, stalled, due. */
function queries(seed: unknown[], stalled: unknown[], due: unknown[]) {
  mFindMany
    .mockResolvedValueOnce(seed)
    .mockResolvedValueOnce(stalled)
    .mockResolvedValueOnce(due);
}

beforeEach(() => {
  mFindMany.mockReset();
  mUpdate.mockReset().mockResolvedValue({});
  mStart.mockReset().mockResolvedValue("sent");
  mExpire.mockReset().mockResolvedValue(true);
  mPlanning.mockReset().mockResolvedValue(false);
});

describe("profilerTick — stalled question reclaim", () => {
  it("reclaims users whose active question passed its deadline", async () => {
    // Before this sweep existed, a single ignored question left
    // `profilerActiveQuestionId` set forever and the dispatch query (which
    // requires it to be null) never picked the user up again — the Profiler
    // died silently for them.
    queries([], [{ userId: "u1" }, { userId: "u2" }], []);

    const res = await profilerTick(api, NOW);

    expect(res.expired).toBe(2);
    expect(mExpire).toHaveBeenCalledTimes(2);
    expect(mExpire).toHaveBeenCalledWith("u1", NOW);
  });

  it("targets exactly the due-but-still-active set", async () => {
    queries([], [], []);
    await profilerTick(api, NOW);

    const stalledQuery = mFindMany.mock.calls[1]![0] as {
      where: Record<string, unknown>;
    };
    expect(stalledQuery.where.profilerActiveQuestionId).toEqual({ not: null });
    // Past the deadline OR the legacy `null` state written before deadlines
    // existed — the users currently stuck in production.
    expect(stalledQuery.where.OR).toEqual([{ profilerNextAt: { lte: NOW } }, { profilerNextAt: null }]);
  });

  it("does not re-ask in the same tick (reclaim re-arms for the next window)", async () => {
    // The reclaim sets profilerNextAt into the future, so the dispatch query
    // below cannot pick the same user up again immediately.
    queries([], [{ userId: "u1" }], []);

    const res = await profilerTick(api, NOW);

    expect(res.expired).toBe(1);
    expect(res.dispatched).toBe(0);
    expect(mStart).not.toHaveBeenCalled();
  });

  it("keeps sweeping when one reclaim throws", async () => {
    queries([], [{ userId: "u1" }, { userId: "u2" }], []);
    mExpire.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await profilerTick(api, NOW);

    expect(res.expired).toBe(1);
    expect(mExpire).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});

describe("profilerTick — dispatch still works", () => {
  it("starts a batch for a due, idle user", async () => {
    queries([], [], [{ userId: "u3", timeZone: "Europe/Kyiv" }]);

    const res = await profilerTick(api, NOW);

    expect(res.dispatched).toBe(1);
    expect(mStart).toHaveBeenCalledWith(api, "u3", NOW);
  });

  it("holds a due user who is mid date-negotiation", async () => {
    queries([], [], [{ userId: "u3", timeZone: "Europe/Kyiv" }]);
    mPlanning.mockResolvedValue(true);

    const res = await profilerTick(api, NOW);

    expect(res.blocked).toBe(1);
    expect(mStart).not.toHaveBeenCalled();
  });
});
