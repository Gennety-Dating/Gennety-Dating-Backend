import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { row: null as { content: string; active: boolean; updatedAt: Date } | null },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    systemKnowledge: {
      findUnique: vi.fn(async () => state.row),
      upsert: vi.fn(async () => ({})),
    },
  },
}));

import { prisma } from "@gennety/db";
import { getOrCompute, wantsFresh } from "./cache.js";

const findUnique = prisma.systemKnowledge.findUnique as ReturnType<typeof vi.fn>;

/** Minimal Express stand-ins — the helper is structurally typed on purpose. */
function ctx(query: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return {
    req: { query },
    res: { setHeader: (name: string, value: string) => void (headers[name] = value) },
    headers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.row = null;
});

describe("getOrCompute", () => {
  it("serves a fresh cache row without recomputing", async () => {
    const generatedAt = new Date(Date.now() - 60_000);
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: generatedAt };
    const compute = vi.fn(async () => ({ n: 2 }));
    const c = ctx();

    const value = await getOrCompute("k", 600, compute, c);

    expect(value).toEqual({ n: 1 });
    expect(compute).not.toHaveBeenCalled();
    expect(c.headers["X-Data-Cache"]).toBe("hit");
    // The age of the numbers on screen, not the age of the request.
    expect(c.headers["X-Data-Generated-At"]).toBe(generatedAt.toISOString());
  });

  it("recomputes once the TTL has elapsed", async () => {
    state.row = {
      content: JSON.stringify({ n: 1 }),
      active: true,
      updatedAt: new Date(Date.now() - 700_000),
    };
    const compute = vi.fn(async () => ({ n: 2 }));
    const c = ctx();

    expect(await getOrCompute("k", 600, compute, c)).toEqual({ n: 2 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(c.headers["X-Data-Cache"]).toBe("miss");
  });

  it("?fresh=1 skips the cache read entirely", async () => {
    // A Refresh button that re-serves the same cached numbers is worse than no
    // button: it tells the operator the data is current when it is not.
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: new Date() };
    const compute = vi.fn(async () => ({ n: 2 }));

    const value = await getOrCompute("k", 600, compute, ctx({ fresh: "1" }));

    expect(value).toEqual({ n: 2 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("recomputes when a cached row is unparseable", async () => {
    state.row = { content: "{ not json", active: true, updatedAt: new Date() };
    const compute = vi.fn(async () => ({ n: 2 }));

    expect(await getOrCompute("k", 600, compute, ctx())).toEqual({ n: 2 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("works with no context at all", async () => {
    const compute = vi.fn(async () => ({ n: 3 }));
    expect(await getOrCompute("k", 600, compute)).toEqual({ n: 3 });
  });
});

describe("wantsFresh", () => {
  it("only accepts the exact opt-in", () => {
    expect(wantsFresh({ req: { query: { fresh: "1" } } })).toBe(true);
    expect(wantsFresh({ req: { query: { fresh: "true" } } })).toBe(false);
    expect(wantsFresh({ req: { query: {} } })).toBe(false);
    expect(wantsFresh(undefined)).toBe(false);
  });
});
