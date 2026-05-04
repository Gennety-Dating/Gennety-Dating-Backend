/**
 * Tests for refresh-token rotation (C-5).
 *
 * Covers:
 *   - Happy path: valid token → revoke old + issue new in one transaction.
 *   - Replay defense: presenting an already-revoked token revokes ALL the
 *     user's sessions and returns null (RFC 6749 §10.4).
 *   - Expired tokens are rejected without side effects.
 *   - Atomicity: if either write inside the transaction fails, the function
 *     throws; we never end up with a half-rotated session pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    JWT_SECRET: "test-secret-long-enough-for-m11-guard",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "30d",
  },
}));

interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

const sessions = new Map<string, SessionRow>();

function findByHash(hash: string): SessionRow | null {
  for (const s of sessions.values()) if (s.refreshTokenHash === hash) return s;
  return null;
}

vi.mock("@gennety/db", () => {
  const prismaMock = {
    userSession: {
      findUnique: vi.fn(async ({ where }: { where: { refreshTokenHash: string } }) =>
        findByHash(where.refreshTokenHash),
      ),
      create: vi.fn(async ({ data }: { data: Omit<SessionRow, "id" | "revokedAt"> }) => {
        const id = `s-${sessions.size + 1}`;
        const row: SessionRow = { id, revokedAt: null, ...data };
        sessions.set(id, row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<SessionRow>;
        }) => {
          const row = sessions.get(where.id);
          if (!row) throw new Error("session not found");
          Object.assign(row, data);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId?: string; id?: string; revokedAt?: null };
          data: Partial<SessionRow>;
        }) => {
          let count = 0;
          for (const s of sessions.values()) {
            const matchesUserId = where.userId === undefined || s.userId === where.userId;
            const matchesId = where.id === undefined || s.id === where.id;
            const matchesRevokedAt = where.revokedAt === undefined || s.revokedAt === where.revokedAt;
            if (!matchesUserId || !matchesId || !matchesRevokedAt) continue;
            Object.assign(s, data);
            count++;
          }
          return { count };
        },
      ),
    },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) =>
      callback(prismaMock),
    ),
  };
  return { prisma: prismaMock };
});

const { rotateRefreshToken, createRefreshToken } = await import("./jwt.js");
const { prisma } = await import("@gennety/db");

beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("rotateRefreshToken (C-5)", () => {
  it("happy path: revokes old + issues new", async () => {
    const raw = await createRefreshToken("u-1", "iPhone");
    const before = sessions.size;
    expect(before).toBe(1);

    const result = await rotateRefreshToken(raw, "iPhone");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("u-1");
    expect(result!.nextRefreshToken).not.toBe(raw);

    // Old session revoked, new session created
    const all = [...sessions.values()];
    expect(all).toHaveLength(2);
    const revoked = all.find((s) => s.revokedAt !== null);
    const fresh = all.find((s) => s.revokedAt === null);
    expect(revoked).toBeDefined();
    expect(fresh).toBeDefined();
    expect(fresh!.userId).toBe("u-1");
  });

  it("returns null for an unknown token", async () => {
    const result = await rotateRefreshToken("not-a-real-token", null);
    expect(result).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const raw = await createRefreshToken("u-1", null);
    // Force expiry on the row created by createRefreshToken
    const [row] = [...sessions.values()];
    row.expiresAt = new Date(Date.now() - 60_000);

    const result = await rotateRefreshToken(raw, null);
    expect(result).toBeNull();
    // Not revoked — just rejected. (Cleanup is the user's next login.)
    expect(row.revokedAt).toBeNull();
  });

  it("REPLAY DEFENSE: presenting an already-revoked token revokes ALL user sessions", async () => {
    // Set up: user has 3 active sessions across devices.
    const raw1 = await createRefreshToken("u-2", "iPhone");
    await createRefreshToken("u-2", "iPad");
    await createRefreshToken("u-2", "MacBook");
    expect([...sessions.values()].filter((s) => s.userId === "u-2")).toHaveLength(3);

    // Legitimate rotate of raw1 — old marked revoked, new created.
    const ok = await rotateRefreshToken(raw1, "iPhone");
    expect(ok).not.toBeNull();
    const stillActive = [...sessions.values()].filter(
      (s) => s.userId === "u-2" && s.revokedAt === null,
    );
    expect(stillActive).toHaveLength(3); // 2 untouched + 1 freshly minted

    // Attacker replays raw1 (already revoked).
    const replay = await rotateRefreshToken(raw1, "stolen-laptop");
    expect(replay).toBeNull();

    // Reuse detection should have NUKED every active session for u-2.
    const liveAfterReplay = [...sessions.values()].filter(
      (s) => s.userId === "u-2" && s.revokedAt === null,
    );
    expect(liveAfterReplay).toHaveLength(0);
  });

  it("rotation goes through prisma.$transaction (atomicity contract)", async () => {
    const raw = await createRefreshToken("u-3", null);
    const txMock = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;
    txMock.mockClear();

    await rotateRefreshToken(raw, null);
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(typeof txMock.mock.calls[0]![0]).toBe("function");
  });

  it("propagates errors from $transaction", async () => {
    const raw = await createRefreshToken("u-4", null);
    const txMock = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;
    txMock.mockRejectedValueOnce(new Error("simulated db blip"));

    await expect(rotateRefreshToken(raw, null)).rejects.toThrow("simulated db blip");
  });

  it("treats a lost revoke race as replay and mints no replacement session", async () => {
    const raw = await createRefreshToken("u-5", null);
    await createRefreshToken("u-5", "iPad");
    const before = sessions.size;

    const updateManyMock = (prisma as unknown as {
      userSession: { updateMany: ReturnType<typeof vi.fn> };
    }).userSession.updateMany;
    updateManyMock
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 2 });

    const result = await rotateRefreshToken(raw, null);

    expect(result).toBeNull();
    expect(sessions.size).toBe(before);
    expect(updateManyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: "s-1", revokedAt: null } }),
    );
    expect(updateManyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { userId: "u-5", revokedAt: null } }),
    );
  });
});
