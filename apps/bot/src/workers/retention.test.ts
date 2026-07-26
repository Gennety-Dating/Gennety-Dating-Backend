import { beforeEach, describe, expect, it, vi } from "vitest";

const emailOtp = { findMany: vi.fn(), deleteMany: vi.fn() };
const phoneOtp = { findMany: vi.fn(), deleteMany: vi.fn() };
const userSession = { findMany: vi.fn(), deleteMany: vi.fn() };
const proxyMessage = { findMany: vi.fn(), deleteMany: vi.fn() };

vi.mock("@gennety/db", () => ({
  prisma: { emailOtp, phoneOtp, userSession, proxyMessage },
}));

const {
  retentionTick,
  OTP_RETENTION_MS,
  SESSION_RETENTION_MS,
  PROXY_MESSAGE_RETENTION_MS,
} = await import("./retention.js");

const NOW = new Date("2026-08-01T03:45:00.000Z");

beforeEach(() => {
  for (const model of [emailOtp, phoneOtp, userSession, proxyMessage]) {
    model.findMany.mockReset().mockResolvedValue([]);
    model.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("retentionTick", () => {
  it("is a no-op when nothing is old enough", async () => {
    const result = await retentionTick(NOW);
    expect(result).toEqual({
      emailOtps: 0,
      phoneOtps: 0,
      sessions: 0,
      proxyMessages: 0,
    });
    for (const model of [emailOtp, phoneOtp, userSession, proxyMessage]) {
      expect(model.deleteMany).not.toHaveBeenCalled();
    }
  });

  it("deletes aged OTP challenges by id, oldest first", async () => {
    emailOtp.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    emailOtp.deleteMany.mockResolvedValue({ count: 2 });

    const result = await retentionTick(NOW);

    expect(emailOtp.findMany.mock.calls[0][0]).toMatchObject({
      where: { createdAt: { lt: new Date(NOW.getTime() - OTP_RETENTION_MS) } },
      orderBy: { createdAt: "asc" },
    });
    expect(emailOtp.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["e1", "e2"] } },
    });
    expect(result.emailOtps).toBe(2);
  });

  it("sweeps phone OTPs — the numbers no user cascade can reach", async () => {
    // `phone_otps` is keyed by NUMBER, not by user, because the funnel starts
    // before a User row exists. Numbers of people who never finished signing up
    // therefore survive a GDPR account deletion; this sweep is what removes them.
    phoneOtp.findMany.mockResolvedValue([{ id: "p1" }]);
    phoneOtp.deleteMany.mockResolvedValue({ count: 1 });

    const result = await retentionTick(NOW);

    expect(result.phoneOtps).toBe(1);
    expect(phoneOtp.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - OTP_RETENTION_MS) },
    });
  });

  it("never sweeps a session that is still usable, or one inside the reuse-detection window", async () => {
    // rotateRefreshToken detects a stolen token by finding an already-REVOKED
    // session by hash and revoking the whole family. Deleting revoked rows too
    // early silently degrades that to "token not found".
    await retentionTick(NOW);

    const cutoff = new Date(NOW.getTime() - SESSION_RETENTION_MS);
    const where = userSession.findMany.mock.calls[0][0].where;
    expect(where.expiresAt).toEqual({ lt: cutoff });
    expect(where.OR).toEqual([
      { revokedAt: null },
      { revokedAt: { lt: cutoff } },
    ]);
  });

  it("keeps proxy messages for the full moderation window", async () => {
    await retentionTick(NOW);
    expect(proxyMessage.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - PROXY_MESSAGE_RETENTION_MS) },
    });
    // 90 days — the same window the reference-selfie scrub uses.
    expect(PROXY_MESSAGE_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("batches each table so one tick cannot run away", async () => {
    await retentionTick(NOW);
    for (const model of [emailOtp, phoneOtp, userSession, proxyMessage]) {
      expect(model.findMany.mock.calls[0][0].take).toBe(1_000);
    }
  });

  it("reports per-table counts", async () => {
    emailOtp.findMany.mockResolvedValue([{ id: "e1" }]);
    emailOtp.deleteMany.mockResolvedValue({ count: 1 });
    proxyMessage.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    proxyMessage.deleteMany.mockResolvedValue({ count: 2 });

    const result = await retentionTick(NOW);

    expect(result).toEqual({
      emailOtps: 1,
      phoneOtps: 0,
      sessions: 0,
      proxyMessages: 2,
    });
  });
});
