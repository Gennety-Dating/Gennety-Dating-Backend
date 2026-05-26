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
  refundSkipPenalty,
  seedEloFromVision,
  type SeedEloDeps,
  type SeedEloResult,
} from "./elo-seed.js";
import { UNVERIFIED_ELO_PENALTY } from "../utils/elo-calculator.js";
import type { AttractivenessResult } from "./vision/score-attractiveness.js";

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
const PHOTO_PATH = "user-1/photo-a.jpg";
const PHOTO_BUFFER = Buffer.from("photo-bytes");

function makeDeps(overrides: Partial<SeedEloDeps> = {}): {
  deps: SeedEloDeps;
  writes: Array<{ userId: string; eloScore: number; details: unknown }>;
} {
  const writes: Array<{ userId: string; eloScore: number; details: unknown }> = [];
  const deps: SeedEloDeps = {
    downloadProfileImage: vi.fn(async () => PHOTO_BUFFER),
    scoreAttractiveness: vi.fn(
      async (): Promise<AttractivenessResult> => ({
        ok: true,
        score: 75,
        breakdown: { symmetry: 80, eyeDistance: 70, faceShape: 75, featureRegularity: 75 },
        rationale: "balanced",
        model: "gpt-test",
      }),
    ),
    persistSeed: vi.fn(async (userId, eloScore, details) => {
      writes.push({ userId, eloScore, details });
    }),
    ...overrides,
  };
  return { deps, writes };
}

describe("seedEloFromVision", () => {
  it("writes the mapped Elo and full breakdown on success", async () => {
    const { deps, writes } = makeDeps();
    const result = await seedEloFromVision(USER_ID, PHOTO_PATH, deps, "image/jpeg");

    const expected: SeedEloResult = { ok: true, elo: mapScoreToElo(75), score: 75 };
    expect(result).toEqual(expected);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.eloScore).toBe(mapScoreToElo(75));
    expect(writes[0]!.details).toMatchObject({
      score: 75,
      elo: mapScoreToElo(75),
      model: "gpt-test",
      breakdown: { symmetry: 80 },
      rationale: "balanced",
    });
  });

  it("skips DB write and returns error=download when photo download fails", async () => {
    const { deps, writes } = makeDeps({
      downloadProfileImage: vi.fn(async () => null),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATH, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "download" });
    expect(writes).toHaveLength(0);
    expect(deps.scoreAttractiveness).not.toHaveBeenCalled();
  });

  it("skips DB write and returns error=vision on vision failure", async () => {
    const { deps, writes } = makeDeps({
      scoreAttractiveness: vi.fn(async () => ({ ok: false, error: "api" }) as const),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATH, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "vision" });
    expect(writes).toHaveLength(0);
  });

  it("skips DB write and returns error=vision on disabled (no API key)", async () => {
    const { deps, writes } = makeDeps({
      scoreAttractiveness: vi.fn(async () => ({ ok: false, error: "disabled" }) as const),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATH, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "vision" });
    expect(writes).toHaveLength(0);
  });

  it("skips DB write and returns error=vision on vision timeout", async () => {
    const { deps, writes } = makeDeps({
      scoreAttractiveness: vi.fn(async () => ({ ok: false, error: "timeout" }) as const),
    });
    const result = await seedEloFromVision(USER_ID, PHOTO_PATH, deps, "image/jpeg");

    expect(result).toEqual({ ok: false, error: "vision" });
    expect(writes).toHaveLength(0);
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
