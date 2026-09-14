import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    verifiedSelfiePath: string | null;
    verifiedAt: Date | null;
    faceMatchedAt: Date | null;
  }>,
  updateMany: vi.fn(async () => ({ count: 1 })),
  deleteStorageObject: vi.fn(async () => true),
}));

// Only the default wiring (`runSelfieRetention()` with no deps) reaches these.
// `findMany` honours the filters it is given the way Postgres would, so a
// query that narrows to verified users visibly returns fewer rows.
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        dbMocks.rows.filter((row) => {
          if (row.verifiedSelfiePath === null) return false;
          const verifiedAt = where.verifiedAt as { not?: null; lt?: Date } | undefined;
          if (verifiedAt) {
            if (row.verifiedAt === null) return false;
            if (verifiedAt.lt && !(row.verifiedAt < verifiedAt.lt)) return false;
          }
          return true;
        }),
      ),
      updateMany: dbMocks.updateMany,
    },
  },
}));
vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage.js")>()),
  deleteStorageObject: dbMocks.deleteStorageObject,
}));

import { runSelfieRetention, selfieStoredAt, type RetentionDeps } from "./selfie-retention.js";

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

// A13-M12: the scrub is about the SELFIE's age, not the account's verification.
describe("selfieStoredAt", () => {
  it("reads the upload time out of the key uploadSelfie mints", () => {
    expect(selfieStoredAt("u1/1715000000000.jpg", null)).toEqual(new Date(1715000000000));
  });

  it("falls back for a key without that shape, and says nothing when neither helps", () => {
    const fallback = new Date("2026-01-01T00:00:00Z");
    expect(selfieStoredAt("u1/persona-selfie.jpg", fallback)).toBe(fallback);
    expect(selfieStoredAt("u1/persona-selfie.jpg", null)).toBeNull();
  });
});

describe("runSelfieRetention — default wiring (A13-M12)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const key = (id: string, daysAgo: number) => `${id}/${NOW.getTime() - daysAgo * DAY}.jpg`;

  it("scrubs an old selfie whatever the verification outcome, and only an old one", async () => {
    dbMocks.rows = [
      // Verified long ago: scrubbed, as before.
      { id: "verified", verifiedSelfiePath: key("verified", 100), verifiedAt: new Date(NOW.getTime() - 100 * DAY), faceMatchedAt: null },
      // Never verified (retryable / manual review / rejected): used to be kept forever.
      { id: "unverified", verifiedSelfiePath: key("unverified", 100), verifiedAt: null, faceMatchedAt: new Date(NOW.getTime() - 100 * DAY) },
      // Verified long ago, but THIS selfie is ten days old (a later retry stored it).
      { id: "fresh-selfie", verifiedSelfiePath: key("fresh-selfie", 10), verifiedAt: new Date(NOW.getTime() - 100 * DAY), faceMatchedAt: null },
    ];

    const result = await runSelfieRetention(undefined, RETENTION_DAYS, NOW);

    expect(result.scanned).toBe(2);
    expect(dbMocks.deleteStorageObject).toHaveBeenCalledWith("selfies", key("verified", 100));
    expect(dbMocks.deleteStorageObject).toHaveBeenCalledWith("selfies", key("unverified", 100));
    expect(dbMocks.deleteStorageObject).not.toHaveBeenCalledWith("selfies", key("fresh-selfie", 10));
  });

  it("clears the pointer only while it still names the scrubbed selfie", async () => {
    dbMocks.rows = [
      { id: "u1", verifiedSelfiePath: key("u1", 120), verifiedAt: null, faceMatchedAt: null },
    ];

    await runSelfieRetention(undefined, RETENTION_DAYS, NOW);

    // A liveness run that stored a new selfie meanwhile keeps its reference.
    expect(dbMocks.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", verifiedSelfiePath: key("u1", 120) },
      data: { verifiedSelfiePath: null },
    });
  });
});
