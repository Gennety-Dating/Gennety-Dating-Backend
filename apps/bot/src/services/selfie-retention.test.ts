import { afterEach, describe, expect, it, vi } from "vitest";
import { runSelfieRetention, type RetentionDeps } from "./selfie-retention.js";

const NOW = new Date("2026-04-30T00:00:00Z");
const RETENTION_DAYS = 90;

interface ExpiredRow {
  id: string;
  verifiedSelfiePath: string;
}

function makeDeps(opts: {
  expired?: ExpiredRow[];
  storageOk?: (path: string) => boolean;
  clearThrows?: Set<string>;
}): { deps: RetentionDeps; storageDeletes: string[]; dbClears: string[] } {
  const storageDeletes: string[] = [];
  const dbClears: string[] = [];

  const deps: RetentionDeps = {
    db: {
      findExpired: vi.fn(async () => opts.expired ?? []),
      clearSelfiePath: vi.fn(async (userId: string) => {
        if (opts.clearThrows?.has(userId)) throw new Error("db down");
        dbClears.push(userId);
      }),
    },
    deleteStorageObject: vi.fn(async (_bucket: string, path: string) => {
      storageDeletes.push(path);
      return opts.storageOk ? opts.storageOk(path) : true;
    }),
  };

  return { deps, storageDeletes, dbClears };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runSelfieRetention", () => {
  it("returns zeros when no expired rows", async () => {
    const { deps } = makeDeps({ expired: [] });
    const result = await runSelfieRetention(deps, RETENTION_DAYS, NOW);
    expect(result).toEqual({
      scanned: 0,
      deletedFromStorage: 0,
      deletedFromDb: 0,
      errors: 0,
    });
  });

  it("scrubs each expired row from both storage and DB", async () => {
    const { deps, storageDeletes, dbClears } = makeDeps({
      expired: [
        { id: "u1", verifiedSelfiePath: "u1/s.jpg" },
        { id: "u2", verifiedSelfiePath: "u2/s.jpg" },
      ],
    });
    const result = await runSelfieRetention(deps, RETENTION_DAYS, NOW);
    expect(result).toEqual({
      scanned: 2,
      deletedFromStorage: 2,
      deletedFromDb: 2,
      errors: 0,
    });
    expect(storageDeletes).toEqual(["u1/s.jpg", "u2/s.jpg"]);
    expect(dbClears).toEqual(["u1", "u2"]);
  });

  it("clears DB pointer even when storage delete returns false", async () => {
    // Storage object already gone (manual cleanup, prior partial run, etc.)
    // — still drop the DB pointer, otherwise the row would loop forever
    // pointing at a non-existent file.
    const { deps, dbClears } = makeDeps({
      expired: [{ id: "u1", verifiedSelfiePath: "u1/s.jpg" }],
      storageOk: () => false,
    });
    const result = await runSelfieRetention(deps, RETENTION_DAYS, NOW);
    expect(result.deletedFromStorage).toBe(0);
    expect(result.deletedFromDb).toBe(1);
    expect(dbClears).toEqual(["u1"]);
  });

  it("counts errors and continues with remaining rows", async () => {
    const { deps } = makeDeps({
      expired: [
        { id: "u1", verifiedSelfiePath: "u1/s.jpg" },
        { id: "u2", verifiedSelfiePath: "u2/s.jpg" },
        { id: "u3", verifiedSelfiePath: "u3/s.jpg" },
      ],
      clearThrows: new Set(["u2"]),
    });
    const result = await runSelfieRetention(deps, RETENTION_DAYS, NOW);
    expect(result.scanned).toBe(3);
    expect(result.deletedFromStorage).toBe(3);
    expect(result.deletedFromDb).toBe(2);
    expect(result.errors).toBe(1);
  });

  it("computes the correct cutoff (90 days before `now`)", async () => {
    const { deps } = makeDeps({ expired: [] });
    await runSelfieRetention(deps, RETENTION_DAYS, NOW);
    const findExpired = deps.db.findExpired as ReturnType<typeof vi.fn>;
    const passedCutoff = findExpired.mock.calls[0]![0] as Date;
    const expected = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(passedCutoff.toISOString()).toBe(expected.toISOString());
  });
});
