import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    row: null as { content: string; active: boolean; updatedAt: Date } | null,
    /** What `upsert` hands back — real Prisma returns the stored `updatedAt`. */
    upsertResult: {} as { updatedAt?: Date },
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    systemKnowledge: {
      findUnique: vi.fn(async () => state.row),
      upsert: vi.fn(async () => state.upsertResult),
      update: vi.fn(async () => ({})),
    },
  },
}));

import { prisma } from "@gennety/db";
import {
  __resetAdminCacheMirrorForTests,
  getOrCompute,
  invalidate,
  wantsFresh,
} from "./cache.js";

const findUnique = prisma.systemKnowledge.findUnique as ReturnType<typeof vi.fn>;
const upsert = prisma.systemKnowledge.upsert as ReturnType<typeof vi.fn>;

/** Minimal Express stand-ins — the helper is structurally typed on purpose. */
function ctx(query: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return {
    req: { query },
    res: { setHeader: (name: string, value: string) => void (headers[name] = value) },
    headers,
  };
}

/** A compute the test finishes by hand, to hold two requests in flight together. */
function heldCompute<T>(value: T) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const compute = vi.fn(async () => {
    await gate;
    return value;
  });
  return { compute, release };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  state.row = null;
  state.upsertResult = {};
  __resetAdminCacheMirrorForTests();
});

afterEach(() => {
  vi.useRealTimers();
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

  it("stamps the headers and then fails when the write fails, as before", async () => {
    upsert.mockRejectedValueOnce(new Error("db down"));
    const c = ctx();

    await expect(getOrCompute("k", 600, async () => ({ n: 1 }), c)).rejects.toThrow("db down");
    expect(c.headers["X-Data-Cache"]).toBe("miss");
    // Nothing was stored, so nothing may be served from memory either.
    state.row = null;
    const compute = vi.fn(async () => ({ n: 2 }));
    expect(await getOrCompute("k", 600, compute)).toEqual({ n: 2 });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("getOrCompute — concurrent callers share one lookup", () => {
  it("computes once for simultaneous misses on the same key", async () => {
    const { compute, release } = heldCompute({ n: 1, at: new Date("2026-10-01T00:00:00Z") });
    const c1 = ctx();
    const c2 = ctx();
    const second = vi.fn(async () => ({ n: 99, at: new Date() }));

    const p1 = getOrCompute("k", 600, compute, c1);
    const p2 = getOrCompute("k", 600, second, c2);
    await flush();
    release();
    const [v1, v2] = await Promise.all([p1, p2]);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    // The same answer on the wire, and never the same object in memory.
    expect(JSON.stringify(v2)).toBe(JSON.stringify(v1));
    expect(v2).not.toBe(v1);
    // The caller that computed keeps its own value exactly as before; the one
    // that joined gets the stored form — what a cache hit hands out.
    expect(v1.at).toBeInstanceOf(Date);
    expect(v2.at).toBe("2026-10-01T00:00:00.000Z");
    expect(c1.headers["X-Data-Cache"]).toBe("miss");
    expect(c2.headers["X-Data-Cache"]).toBe("miss");
    expect(c2.headers["X-Data-Generated-At"]).toBe(c1.headers["X-Data-Generated-At"]);
  });

  it("shares one read for simultaneous hits, each caller with its own copy", async () => {
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: new Date() };
    const compute = vi.fn(async () => ({ n: 2 }));

    const [v1, v2] = await Promise.all([
      getOrCompute("k", 600, compute),
      getOrCompute("k", 600, compute),
    ]);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(v1).toEqual({ n: 1 });
    expect(v2).toEqual({ n: 1 });
    expect(v2).not.toBe(v1);
  });

  it("hands every waiting caller the compute's failure", async () => {
    let fail!: (err: Error) => void;
    const compute = vi.fn(
      () => new Promise<{ n: number }>((_resolve, reject) => (fail = reject)),
    );
    const p1 = getOrCompute("k", 600, compute);
    const p2 = getOrCompute("k", 600, compute);
    await flush();
    fail(new Error("query failed"));

    await expect(p1).rejects.toThrow("query failed");
    await expect(p2).rejects.toThrow("query failed");
    expect(compute).toHaveBeenCalledTimes(1);
    // Nothing is kept: the next caller starts over.
    const next = vi.fn(async () => ({ n: 3 }));
    expect(await getOrCompute("k", 600, next)).toEqual({ n: 3 });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never shares across keys or TTLs", async () => {
    const a = vi.fn(async () => ({ k: "a" }));
    const b = vi.fn(async () => ({ k: "b" }));
    const c = vi.fn(async () => ({ k: "c" }));

    const [va, vb, vc] = await Promise.all([
      getOrCompute("a", 600, a),
      getOrCompute("b", 600, b),
      getOrCompute("a", 900, c),
    ]);

    expect([va, vb, vc]).toEqual([{ k: "a" }, { k: "b" }, { k: "c" }]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("?fresh=1 neither joins a lookup in flight nor lets one join it", async () => {
    const held = heldCompute({ n: 1 });
    const fresh = vi.fn(async () => ({ n: 2 }));

    const normal = getOrCompute("k", 600, held.compute);
    await flush();
    const forced = getOrCompute("k", 600, fresh, ctx({ fresh: "1" }));
    expect(await forced).toEqual({ n: 2 });
    expect(fresh).toHaveBeenCalledTimes(1);

    held.release();
    expect(await normal).toEqual({ n: 1 });
    expect(held.compute).toHaveBeenCalledTimes(1);
  });

  it("starts a new lookup for a caller that arrives after the last one landed", async () => {
    const compute = vi.fn(async () => ({ n: 1 }));
    await getOrCompute("k", 600, compute);
    await getOrCompute("k", 600, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe("getOrCompute — in-process mirror of the stored row", () => {
  it("serves the row it just wrote without reading it back, with the stored timestamp", async () => {
    const storedAt = new Date(Date.now() - 1_000);
    state.upsertResult = { updatedAt: storedAt };
    const at = new Date("2026-10-01T00:00:00Z");
    await getOrCompute("k", 600, async () => ({ n: 1, at }));
    findUnique.mockClear();

    const c = ctx();
    const compute = vi.fn(async () => ({ n: 2, at: new Date() }));
    const value = await getOrCompute("k", 600, compute, c);

    expect(findUnique).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
    // Byte-for-byte what a database hit returns: the parsed stored JSON.
    expect(value).toEqual({ n: 1, at: "2026-10-01T00:00:00.000Z" });
    expect(c.headers["X-Data-Cache"]).toBe("hit");
    expect(c.headers["X-Data-Generated-At"]).toBe(storedAt.toISOString());
  });

  it("hands out a new object on every hit", async () => {
    state.upsertResult = { updatedAt: new Date() };
    await getOrCompute("k", 600, async () => ({ list: [1] }));

    const first = await getOrCompute("k", 600, async () => ({ list: [2] }));
    first.list.push(42);
    const second = await getOrCompute("k", 600, async () => ({ list: [2] }));

    expect(second).toEqual({ list: [1] });
  });

  it("expires exactly when the database row would — the TTL is never extended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const storedAt = new Date("2026-10-13T10:00:00.000Z");
    vi.setSystemTime(storedAt);
    state.upsertResult = { updatedAt: storedAt };
    await getOrCompute("k", 600, async () => ({ n: 1 }));
    // What the database now holds — the same row the mirror copied.
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: storedAt };
    findUnique.mockClear();

    vi.setSystemTime(new Date(storedAt.getTime() + 599_999));
    expect(await getOrCompute("k", 600, async () => ({ n: 2 }))).toEqual({ n: 1 });
    expect(findUnique).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(storedAt.getTime() + 600_000));
    const compute = vi.fn(async () => ({ n: 2 }));
    expect(await getOrCompute("k", 600, compute)).toEqual({ n: 2 });
    // Expired in memory → the database is asked, exactly as before.
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("mirrors a row it read, keeping the database's timestamp", async () => {
    const storedAt = new Date(Date.now() - 30_000);
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: storedAt };
    await getOrCompute("k", 600, async () => ({ n: 2 }));
    findUnique.mockClear();

    const c = ctx();
    expect(await getOrCompute("k", 600, async () => ({ n: 2 }), c)).toEqual({ n: 1 });
    expect(findUnique).not.toHaveBeenCalled();
    expect(c.headers["X-Data-Generated-At"]).toBe(storedAt.toISOString());
  });

  it("does not mirror an inactive row", async () => {
    state.row = { content: JSON.stringify({ n: 1 }), active: false, updatedAt: new Date() };
    await getOrCompute("k", 600, async () => ({ n: 2 }));
    state.row = null;
    findUnique.mockClear();

    await getOrCompute("k", 600, async () => ({ n: 3 }));
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("invalidate() drops the copy, so the next read goes to the database", async () => {
    state.upsertResult = { updatedAt: new Date() };
    await getOrCompute("k", 600, async () => ({ n: 1 }));

    await invalidate("k");
    state.row = { content: JSON.stringify({ n: 1 }), active: false, updatedAt: new Date() };
    findUnique.mockClear();
    const compute = vi.fn(async () => ({ n: 2 }));

    expect(await getOrCompute("k", 600, compute)).toEqual({ n: 2 });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("asks the database while a write for the key is in flight", async () => {
    state.upsertResult = { updatedAt: new Date() };
    await getOrCompute("k", 600, async () => ({ n: 1 }));

    let finishWrite!: () => void;
    upsert.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve({ updatedAt: new Date() });
        }),
    );
    const refresh = getOrCompute("k", 600, async () => ({ n: 2 }), ctx({ fresh: "1" }));
    await flush();
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: new Date() };
    findUnique.mockClear();

    await getOrCompute("k", 600, async () => ({ n: 3 }));
    expect(findUnique).toHaveBeenCalledTimes(1);

    finishWrite();
    await refresh;
  });

  it("does not refill the copy when two writes overlap", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    upsert
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishFirst = () => resolve({ updatedAt: new Date() }))),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishSecond = () => resolve({ updatedAt: new Date() }))),
      );
    const first = getOrCompute("k", 600, async () => ({ n: 1 }), ctx({ fresh: "1" }));
    const second = getOrCompute("k", 600, async () => ({ n: 2 }), ctx({ fresh: "1" }));
    await flush();
    finishSecond();
    finishFirst();
    await Promise.all([first, second]);

    // Which value the database kept is not knowable from here — so it decides.
    state.row = { content: JSON.stringify({ n: 1 }), active: true, updatedAt: new Date() };
    expect(await getOrCompute("k", 600, async () => ({ n: 3 }))).toEqual({ n: 1 });
    expect(findUnique).toHaveBeenCalledTimes(1);
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
