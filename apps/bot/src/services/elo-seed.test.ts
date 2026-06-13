import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  env: { ELO_VISION_SEED_ENABLED: true },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    user: { updateMany: vi.fn(), findUnique: vi.fn() },
    profile: { update: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from "@gennety/db";
import {
  mapScoreToElo,
  persistVisionSeed,
  refundSkipPenalty,
  seedEloFromVision,
  type SeedEloDeps,
  type SeedEloResult,
} from "./elo-seed.js";
import { UNVERIFIED_ELO_PENALTY } from "../utils/elo-calculator.js";
import type { AttractivenessBatchResult } from "./vision/score-attractiveness.js";

describe("mapScoreToElo", () => {
  it("maps 0 to ELO_SEED_MIN (200)", () => {
    expect(mapScoreToElo(0)).toBe(200);
  });

  it("maps 100 to ELO_SEED_MAX (800)", () => {
    expect(mapScoreToElo(100)).toBe(800);
  });

  it("maps the population mean (50) to the default Elo (500)", () => {
    expect(mapScoreToElo(50)).toBe(500);
  });

  it("clamps out-of-range inputs", () => {
    expect(mapScoreToElo(-10)).toBe(200);
    expect(mapScoreToElo(150)).toBe(800);
  });

  it("rounds to integer Elo", () => {
    expect(mapScoreToElo(33.4)).toBe(Math.round(200 + 33.4 * 6));
    expect(Number.isInteger(mapScoreToElo(33.4))).toBe(true);
  });
});

const USER_ID = "user-1";
const PHOTO_PATHS = ["user-1/photo-a.jpg", "user-1/photo-b.jpg"];
const PHOTO_BUFFERS: Record<string, Buffer> = {
  [PHOTO_PATHS[0]!]: Buffer.from("photo-a-bytes"),
  [PHOTO_PATHS[1]!]: Buffer.from("photo-b-bytes"),
};

function makeDeps(overrides: Partial<SeedEloDeps> = {}): {
  deps: SeedEloDeps;
  writes: Array<{ userId: string; eloScore: number; details: unknown }>;
} {
  const writes: Array<{ userId: string; eloScore: number; details: unknown }> = [];
  const deps: SeedEloDeps = {
    downloadProfileImage: vi.fn(async (path) => PHOTO_BUFFERS[path] ?? null),
    scoreAttractiveness: vi.fn(
      async (): Promise<AttractivenessBatchResult> => ({
        ok: true,
        assessments: [
          {
            score: 60,
            breakdown: {
              symmetry: 70,
              eyeDistance: 50,
              faceShape: 60,
              featureRegularity: 55,
            },
            rationale: "photo one",
          },
          {
            score: 80,
            breakdown: {
              symmetry: 90,
              eyeDistance: 70,
              faceShape: 80,
              featureRegularity: 75,
            },
            rationale: "photo two",
          },
        ],
        model: "gpt-test",
      }),
    ),
    persistSeed: vi.fn(async (userId, eloScore, details) => {
      writes.push({ userId, eloScore, details });
      return "persisted" as const;
    }),
    ...overrides,
  };
  return { deps, writes };
}

describe("seedEloFromVision", () => {
  it("writes Elo from the arithmetic mean and keeps per-photo audit details", async () => {
    const { deps, writes } = makeDeps();
    const result = await seedEloFromVision(USER_ID, PHOTO_PATHS, deps, "image/jpeg");

    const expected: SeedEloResult = { ok: true, elo: mapScoreToElo(70), score: 70 };
    expect(result).toEqual(expected);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.eloScore).toBe(mapScoreToElo(70));
    expect(writes[0]!.details).toMatchObject({
      score: 70,
      elo: mapScoreToElo(70),
      model: "gpt-test",
      breakdown: {
        symmetry: 80,
        eyeDistance: 60,
        faceShape: 70,
        featureRegularity: 65,
      },
      rationale: "Arithmetic mean of 2 profile photo scores",
      aggregation: "arithmetic_mean",
      photoCount: 2,
      photos: [
        { index: 1, score: 60, rationale: "photo one" },
        { index: 2, score: 80, rationale: "photo two" },
      ],
    });
    expect(deps.downloadProfileImage).toHaveBeenCalledTimes(2);
    expect(deps.scoreAttractiveness).toHaveBeenCalledTimes(1);
    expect(deps.scoreAttractiveness).toHaveBeenCalledWith([
      { buffer: PHOTO_BUFFERS[PHOTO_PATHS[0]!], mime: "image/jpeg" },
      { buffer: PHOTO_BUFFERS[PHOTO_PATHS[1]!], mime: "image/jpeg" },
    ]);
  });

  it("skips DB write when any download fails instead of using a partial mean", async () => {
    const { deps, writes } = makeDeps({
      downloadProfileImage: vi.fn(async (path) =>
        path === PHOTO_PATHS[1] ? null : PHOTO_BUFFERS[path] ?? null,
      ),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATHS, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "download" });
    expect(writes).toHaveLength(0);
    expect(deps.scoreAttractiveness).not.toHaveBeenCalled();
  });

  it("skips DB write and returns error=vision on vision failure", async () => {
    const { deps, writes } = makeDeps({
      scoreAttractiveness: vi.fn(async () => ({ ok: false, error: "api" }) as const),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATHS, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "vision" });
    expect(writes).toHaveLength(0);
  });

  it("skips DB write and returns error=vision on disabled (no API key)", async () => {
    const { deps, writes } = makeDeps({
      scoreAttractiveness: vi.fn(async () => ({ ok: false, error: "disabled" }) as const),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATHS, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "vision" });
    expect(writes).toHaveLength(0);
  });

  it("skips DB write and returns error=vision on vision timeout", async () => {
    const { deps, writes } = makeDeps({
      scoreAttractiveness: vi.fn(async () => ({ ok: false, error: "timeout" }) as const),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATHS, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "vision" });
    expect(writes).toHaveLength(0);
  });

  it("uses the detected MIME for each downloaded photo", async () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);
    const { deps } = makeDeps({
      downloadProfileImage: vi
        .fn()
        .mockResolvedValueOnce(jpeg)
        .mockResolvedValueOnce(png),
    });

    await seedEloFromVision(USER_ID, PHOTO_PATHS, deps);

    expect(deps.scoreAttractiveness).toHaveBeenCalledWith([
      { buffer: jpeg, mime: "image/jpeg" },
      { buffer: png, mime: "image/png" },
    ]);
  });

  it("discards the seed when photos change while OpenAI is scoring", async () => {
    const { deps, writes } = makeDeps({
      persistSeed: vi.fn(async () => "photos_changed" as const),
    });

    const result = await seedEloFromVision(USER_ID, PHOTO_PATHS, deps);

    expect(result).toEqual({ ok: false, error: "photos_changed" });
    expect(writes).toHaveLength(0);
  });
});

describe("persistVisionSeed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes only when the current photos still equal the scored snapshot", async () => {
    (prisma.profile.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
    });
    const details = {
      score: 70,
      elo: 620,
      model: "gpt-test",
      breakdown: {
        symmetry: 70,
        eyeDistance: 70,
        faceShape: 70,
        featureRegularity: 70,
      },
      rationale: "mean",
      seededAt: "2026-06-13T00:00:00.000Z",
      aggregation: "arithmetic_mean" as const,
      photoCount: 2,
      photos: [],
    };

    const result = await persistVisionSeed(USER_ID, PHOTO_PATHS, 620, details);

    expect(result).toBe("persisted");
    expect(prisma.profile.updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        eloSeededAt: null,
        photos: { equals: PHOTO_PATHS },
      },
      data: {
        eloScore: 620,
        eloSeededAt: expect.any(Date),
        eloSeedDetails: details,
      },
    });
  });

  it("reports photos_changed when the snapshot CAS misses an unseeded row", async () => {
    (prisma.profile.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 0,
    });
    (prisma.profile.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      eloSeededAt: null,
    });
    const details = {
      score: 70,
      elo: 620,
      model: "gpt-test",
      breakdown: {
        symmetry: 70,
        eyeDistance: 70,
        faceShape: 70,
        featureRegularity: 70,
      },
      rationale: "mean",
      seededAt: "2026-06-13T00:00:00.000Z",
      aggregation: "arithmetic_mean" as const,
      photoCount: 2,
      photos: [],
    };

    const result = await persistVisionSeed(USER_ID, PHOTO_PATHS, 620, details);

    expect(result).toBe("photos_changed");
  });
});

type TxLike = {
  user: { updateMany: ReturnType<typeof vi.fn> };
  profile: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe("refundSkipPenalty", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refunds the skip penalty and marks seeded with refund details", async () => {
    const tx: TxLike = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      profile: {
        findUnique: vi.fn().mockResolvedValue({ eloScore: 350 }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: TxLike) => Promise<unknown>) => fn(tx),
    );

    const result = await refundSkipPenalty("user-1");

    expect(result).toEqual({
      ok: true,
      elo: 350 + UNVERIFIED_ELO_PENALTY,
      score: 0,
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", verificationSkippedAt: { not: null } },
      data: { verificationSkippedAt: null },
    });
    const updateCall = tx.profile.update.mock.calls[0]![0];
    expect(updateCall.data.eloScore).toBe(500);
    expect(updateCall.data.eloSeededAt).toBeInstanceOf(Date);
    expect(updateCall.data.eloSeedDetails.model).toBe("refund-no-vision");
    expect(updateCall.data.eloSeedDetails.rationale).toMatch(/strategy B/);
  });

  it("clamps the refunded Elo to ELO_MAX (1000)", async () => {
    const tx: TxLike = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      profile: {
        findUnique: vi.fn().mockResolvedValue({ eloScore: 900 }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: TxLike) => Promise<unknown>) => fn(tx),
    );

    const result = await refundSkipPenalty("user-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elo).toBe(1000); // clamped, not 1050
  });

  it("is a no-op when the user was never skipped (idempotency)", async () => {
    const tx: TxLike = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      profile: {
        findUnique: vi.fn().mockResolvedValue({ eloScore: 500 }),
        update: vi.fn(),
      },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: TxLike) => Promise<unknown>) => fn(tx),
    );

    const result = await refundSkipPenalty("user-1");

    expect(result).toEqual({ ok: true, elo: 500, score: 0 });
    expect(tx.profile.update).not.toHaveBeenCalled();
  });

  it("returns error=vision and swallows DB failures", async () => {
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection lost"),
    );
    const result = await refundSkipPenalty("user-1");
    expect(result).toEqual({ ok: false, error: "vision" });
  });
});
