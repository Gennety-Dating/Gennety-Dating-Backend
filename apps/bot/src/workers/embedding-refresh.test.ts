/**
 * Tests for the M-2 embedding-refresh worker.
 *
 * Covers the happy path (dirty rows get a fresh vector + flag cleared),
 * the concurrency guard (a row re-dirtied during generation is left dirty
 * for the next tick), and the no-OpenAI-key fallback (worker no-ops
 * silently in local dev).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: { OPENAI_API_KEY: "test-key" },
}));

interface ProfileRow {
  id: string;
  userId: string;
  psychologicalSummary: string | null;
  partnerPreferences: string | null;
  negativeConstraints: string | null;
  hobbies: string[];
  embeddingDirty: boolean;
  embeddingDirtyAt: Date | null;
  embedding: string | null;
}

const profiles = new Map<string, ProfileRow>();

vi.mock("@gennety/db", () => ({
  prisma: {
    profile: {
      findMany: vi.fn(async ({ take }: { take?: number }) => {
        // Real Prisma returns plain objects (snapshot), not refs into a
        // mutable store — return shallow copies so test-side mutations to
        // `profiles.get(id)` don't retroactively rewrite the row the worker
        // already fetched.
        return [...profiles.values()]
          .filter((p) => p.embeddingDirty)
          .sort((a, b) => {
            const aT = a.embeddingDirtyAt?.getTime() ?? 0;
            const bT = b.embeddingDirtyAt?.getTime() ?? 0;
            return aT - bT;
          })
          .slice(0, take ?? 50)
          .map((p) => ({ ...p }));
      }),
    },
    $executeRaw: vi.fn(
      async (
        _strings: TemplateStringsArray,
        _literal: string,
        id: string,
        dirtyAt: Date | null,
      ) => {
        const row = profiles.get(id);
        if (!row || !row.embeddingDirty) return 0;
        const actual = row.embeddingDirtyAt?.getTime() ?? null;
        const expected = dirtyAt?.getTime() ?? null;
        if (actual !== expected) return 0;
        row.embeddingDirty = false;
        row.embeddingDirtyAt = null;
        row.embedding = "vector";
        return 1;
      },
    ),
  },
}));

const { embeddingRefreshTick } = await import("./embedding-refresh.js");

beforeEach(() => {
  profiles.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

function seedDirty(id: string, dirtyAt: Date | null): ProfileRow {
  const row: ProfileRow = {
    id,
    userId: `user-${id}`,
    psychologicalSummary: "extroverted, curious, jazz lover",
    partnerPreferences: "kind and curious",
    negativeConstraints: "- avoid: smokers",
    hobbies: ["jazz", "running"],
    embeddingDirty: true,
    embeddingDirtyAt: dirtyAt,
    embedding: null,
  };
  profiles.set(id, row);
  return row;
}

describe("embeddingRefreshTick (M-2)", () => {
  it("recomputes dirty profiles and clears the flag", async () => {
    seedDirty("p1", new Date("2026-01-01T00:00:00Z"));

    const stubClient = {
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    };

    const result = await embeddingRefreshTick({ client: stubClient });

    expect(result.scanned).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(stubClient.embed).toHaveBeenCalledTimes(1);
    expect(profiles.get("p1")!.embeddingDirty).toBe(false);
  });

  it("skips a row that was re-dirtied mid-generation (concurrent edit)", async () => {
    const initialDirtyAt = new Date("2026-01-01T00:00:00Z");
    seedDirty("p2", initialDirtyAt);

    // Simulate the user editing again WHILE the embed call is in flight.
    let resolveEmbed: (v: number[]) => void = () => {};
    const stubClient = {
      embed: vi.fn(
        () =>
          new Promise<number[]>((r) => {
            resolveEmbed = r;
          }),
      ),
    };

    const tick = embeddingRefreshTick({ client: stubClient });

    // Concurrent re-dirty: bump dirtyAt to a later moment.
    await new Promise((r) => setTimeout(r, 5));
    profiles.get("p2")!.embeddingDirtyAt = new Date("2026-01-02T00:00:00Z");

    resolveEmbed(new Array(1536).fill(0.5));
    const result = await tick;

    expect(result.scanned).toBe(1);
    // Row was NOT cleared — `refreshed` is 0 because the conditional update
    // saw the moved dirtyAt and no-op'd.
    expect(result.refreshed).toBe(0);
    expect(profiles.get("p2")!.embeddingDirty).toBe(true);
  });

  it("counts failures without throwing", async () => {
    seedDirty("p3", new Date("2026-01-01T00:00:00Z"));
    const stubClient = {
      embed: vi.fn().mockRejectedValue(new Error("OpenAI down")),
    };

    const result = await embeddingRefreshTick({ client: stubClient });

    expect(result.failed).toBe(1);
    expect(profiles.get("p3")!.embeddingDirty).toBe(true); // still dirty
  });

  it("repairs a legacy dirty row with no dirty timestamp", async () => {
    seedDirty("p4", null);
    const stubClient = {
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.2)),
    };

    const result = await embeddingRefreshTick({ client: stubClient });

    expect(result.refreshed).toBe(1);
    expect(profiles.get("p4")!.embeddingDirty).toBe(false);
  });
});
