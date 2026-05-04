import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    profile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import {
  applyEloUpdate,
  expectedScore,
  kFactor,
  resolveMatchElo,
  updateEloScores,
  ELO_MAX,
  ELO_MIN,
  K_FACTOR_CALIBRATING,
  K_FACTOR_STABLE,
} from "./elo-calculator.js";

describe("expectedScore", () => {
  it("returns 0.5 for equal ratings", () => {
    expect(expectedScore(500, 500)).toBeCloseTo(0.5);
  });

  it("returns ~0.91 for a 400-point lead", () => {
    expect(expectedScore(900, 500)).toBeCloseTo(0.909, 2);
  });

  it("is symmetric: E(A,B) + E(B,A) === 1", () => {
    const a = expectedScore(620, 480);
    const b = expectedScore(480, 620);
    expect(a + b).toBeCloseTo(1);
  });
});

describe("kFactor", () => {
  it("returns the calibrating K for newbies (< 10 matches)", () => {
    expect(kFactor(0)).toBe(K_FACTOR_CALIBRATING);
    expect(kFactor(9)).toBe(K_FACTOR_CALIBRATING);
  });

  it("returns the stable K once threshold is crossed", () => {
    expect(kFactor(10)).toBe(K_FACTOR_STABLE);
    expect(kFactor(50)).toBe(K_FACTOR_STABLE);
  });
});

describe("applyEloUpdate", () => {
  it("a win against an equal opponent on K=40 → +20", () => {
    const result = applyEloUpdate({ eloScore: 500, eloMatchesPlayed: 0 }, 500, 1);
    expect(result.eloScore).toBe(520);
    expect(result.eloMatchesPlayed).toBe(1);
  });

  it("a loss against an equal opponent on K=40 → -20", () => {
    const result = applyEloUpdate({ eloScore: 500, eloMatchesPlayed: 0 }, 500, 0);
    expect(result.eloScore).toBe(480);
  });

  it("upset (lower-rated wins) gains more than expected", () => {
    const upset = applyEloUpdate({ eloScore: 500, eloMatchesPlayed: 20 }, 800, 1);
    const expectedWin = applyEloUpdate({ eloScore: 800, eloMatchesPlayed: 20 }, 500, 1);
    expect(upset.eloScore - 500).toBeGreaterThan(expectedWin.eloScore - 800);
  });

  it("clamps to ELO_MIN on a heavy-favourite loss streak", () => {
    let player = { eloScore: 30, eloMatchesPlayed: 100 };
    for (let i = 0; i < 20; i++) {
      const next = applyEloUpdate(player, 900, 0);
      player = { eloScore: next.eloScore, eloMatchesPlayed: next.eloMatchesPlayed };
    }
    expect(player.eloScore).toBeGreaterThanOrEqual(ELO_MIN);
  });

  it("clamps to ELO_MAX on a heavy-underdog win streak", () => {
    let player = { eloScore: 985, eloMatchesPlayed: 100 };
    for (let i = 0; i < 20; i++) {
      const next = applyEloUpdate(player, 100, 1);
      player = { eloScore: next.eloScore, eloMatchesPlayed: next.eloMatchesPlayed };
    }
    expect(player.eloScore).toBeLessThanOrEqual(ELO_MAX);
  });

  it("uses the player's own K, not the opponent's match count", () => {
    const newbieWin = applyEloUpdate({ eloScore: 500, eloMatchesPlayed: 0 }, 500, 1);
    const veteranWin = applyEloUpdate({ eloScore: 500, eloMatchesPlayed: 50 }, 500, 1);
    expect(newbieWin.eloScore - 500).toBeGreaterThan(veteranWin.eloScore - 500);
  });
});

describe("resolveMatchElo (decision matrix)", () => {
  const equalA = { eloScore: 500, eloMatchesPlayed: 20 };
  const equalB = { eloScore: 500, eloMatchesPlayed: 20 };

  it("mutual accept → both gain", () => {
    const r = resolveMatchElo(equalA, equalB, true, true);
    expect(r.userA!.eloScore).toBeGreaterThan(500);
    expect(r.userB!.eloScore).toBeGreaterThan(500);
  });

  it("mutual decline → both lose", () => {
    const r = resolveMatchElo(equalA, equalB, false, false);
    expect(r.userA!.eloScore).toBeLessThan(500);
    expect(r.userB!.eloScore).toBeLessThan(500);
  });

  it("mixed (A accepts, B declines) → B gains, A loses", () => {
    const r = resolveMatchElo(equalA, equalB, true, false);
    // A loses (B's decline drives A's outcome).
    expect(r.userA!.eloScore).toBeLessThan(500);
    // B gains (A's accept drives B's outcome).
    expect(r.userB!.eloScore).toBeGreaterThan(500);
  });

  it("mixed (A declines, B accepts) → A gains, B loses (symmetric)", () => {
    const r = resolveMatchElo(equalA, equalB, false, true);
    expect(r.userA!.eloScore).toBeGreaterThan(500);
    expect(r.userB!.eloScore).toBeLessThan(500);
  });

  it("each direction uses its own opponent's rating in expectedScore", () => {
    // Asymmetric ratings: A=700, B=400. Mutual accept.
    const r = resolveMatchElo(
      { eloScore: 700, eloMatchesPlayed: 20 },
      { eloScore: 400, eloMatchesPlayed: 20 },
      true,
      true,
    );
    // A was favoured to win against 400 → small gain.
    // B was the underdog against 700 → large gain.
    const aGain = r.userA!.eloScore - 700;
    const bGain = r.userB!.eloScore - 400;
    expect(bGain).toBeGreaterThan(aGain);
  });

  it("null decision from one side leaves the OTHER user's Elo unchanged", () => {
    // A declines first (cancels match before B can decide).
    // → B's Elo updates from A's verdict (B loses).
    // → A's Elo doesn't change because B never passed a verdict.
    const r = resolveMatchElo(equalA, equalB, false, null);
    expect(r.userA).toBeNull();
    expect(r.userB).not.toBeNull();
    expect(r.userB!.eloScore).toBeLessThan(500);
  });

  it("both null → both updates null", () => {
    const r = resolveMatchElo(equalA, equalB, null, null);
    expect(r.userA).toBeNull();
    expect(r.userB).toBeNull();
  });
});

type TxLike = {
  profile: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe("updateEloScores (DB integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists both updates inside a transaction", async () => {
    const tx: TxLike = {
      profile: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "pa", eloScore: 500, eloMatchesPlayed: 20 })
          .mockResolvedValueOnce({ id: "pb", eloScore: 500, eloMatchesPlayed: 20 }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: TxLike) => Promise<unknown>) => fn(tx),
    );

    const result = await updateEloScores("uA", "uB", true, true);
    expect(result?.userA?.eloScore).toBeGreaterThan(500);
    expect(result?.userB?.eloScore).toBeGreaterThan(500);
    expect(tx.profile.update).toHaveBeenCalledTimes(2);
  });

  it("only writes one row when only one side has a decision", async () => {
    const tx: TxLike = {
      profile: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "pa", eloScore: 500, eloMatchesPlayed: 20 })
          .mockResolvedValueOnce({ id: "pb", eloScore: 500, eloMatchesPlayed: 20 }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: TxLike) => Promise<unknown>) => fn(tx),
    );

    // A declined, B never decided → only B's profile is updated.
    const result = await updateEloScores("uA", "uB", false, null);
    expect(result?.userA).toBeNull();
    expect(result?.userB).not.toBeNull();
    expect(tx.profile.update).toHaveBeenCalledTimes(1);
  });

  it("returns null without touching DB when both decisions are null", async () => {
    const result = await updateEloScores("uA", "uB", null, null);
    expect(result).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns null when either profile is missing", async () => {
    const tx: TxLike = {
      profile: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "pa", eloScore: 500, eloMatchesPlayed: 0 })
          .mockResolvedValueOnce(null),
        update: vi.fn(),
      },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: TxLike) => Promise<unknown>) => fn(tx),
    );

    const result = await updateEloScores("uA", "uB", true, true);
    expect(result).toBeNull();
    expect(tx.profile.update).not.toHaveBeenCalled();
  });

  it("swallows DB errors and returns null", async () => {
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection lost"),
    );
    const result = await updateEloScores("uA", "uB", true, true);
    expect(result).toBeNull();
  });
});
