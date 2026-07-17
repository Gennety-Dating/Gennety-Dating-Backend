import { beforeEach, describe, expect, it, vi } from "vitest";

const emailOtpCreate = vi.fn();
const emailOtpDelete = vi.fn();
const emailOtpFindFirst = vi.fn();
const emailOtpUpdateMany = vi.fn();
const queryRawUnsafe = vi.fn();

const prismaMock = {
  emailOtp: {
    create: emailOtpCreate,
    delete: emailOtpDelete,
    findFirst: emailOtpFindFirst,
    updateMany: emailOtpUpdateMany,
  },
  $queryRawUnsafe: queryRawUnsafe,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
};

vi.mock("@gennety/db", () => ({
  prisma: prismaMock,
}));

vi.mock("../services/email.js", () => ({
  sendOtpEmail: vi.fn(),
}));

const {
  createAndSendOtp,
  getOtpChallengeState,
  verifyOtp,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
} = await import("./otp.js");

beforeEach(() => {
  emailOtpCreate.mockReset();
  emailOtpDelete.mockReset();
  emailOtpFindFirst.mockReset();
  emailOtpUpdateMany.mockReset();
  queryRawUnsafe.mockReset();
});

describe("OTP challenge state", () => {
  it("reports a live challenge as pending", async () => {
    const createdAt = new Date("2026-06-07T10:00:00.000Z");
    const expiresAt = new Date("2026-06-07T10:10:00.000Z");
    emailOtpFindFirst.mockResolvedValue({ createdAt, expiresAt, attempts: 2 });

    const state = await getOtpChallengeState(
      "Alice@Stanford.edu",
      new Date("2026-06-07T10:05:00.000Z"),
    );

    expect(emailOtpFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "alice@stanford.edu", consumedAt: null },
      }),
    );
    expect(state).toEqual({
      status: "pending",
      expiresAt,
      resendAvailableAt: new Date(createdAt.getTime() + OTP_RESEND_COOLDOWN_MS),
      attemptsRemaining: OTP_MAX_ATTEMPTS - 2,
    });
  });

  it("distinguishes expired and exhausted challenges", async () => {
    const createdAt = new Date("2026-06-07T10:00:00.000Z");
    const expiresAt = new Date("2026-06-07T10:10:00.000Z");
    emailOtpFindFirst.mockResolvedValueOnce({ createdAt, expiresAt, attempts: 0 });
    emailOtpFindFirst.mockResolvedValueOnce({
      createdAt,
      expiresAt: new Date("2026-06-07T10:30:00.000Z"),
      attempts: OTP_MAX_ATTEMPTS,
    });

    await expect(
      getOtpChallengeState("alice@stanford.edu", new Date("2026-06-07T10:11:00.000Z")),
    ).resolves.toMatchObject({ status: "expired" });
    await expect(
      getOtpChallengeState("alice@stanford.edu", new Date("2026-06-07T10:11:00.000Z")),
    ).resolves.toMatchObject({ status: "exhausted", attemptsRemaining: 0 });
  });

  it("rolls back the challenge transaction when email delivery fails", async () => {
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpCreate.mockResolvedValue({
      id: "otp-1",
      createdAt: new Date(),
    });
    const send = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    await expect(createAndSendOtp("alice@stanford.edu", send)).rejects.toThrow(
      "provider unavailable",
    );
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "alice@stanford.edu",
    );
  });

  it("returns the existing challenge without sending during the cooldown", async () => {
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + 60_000);
    emailOtpFindFirst.mockResolvedValue({ createdAt, expiresAt, attempts: 1 });
    const send = vi.fn();

    await expect(createAndSendOtp("Alice@Stanford.edu", send)).resolves.toMatchObject({
      status: "pending",
      expiresAt,
      attemptsRemaining: OTP_MAX_ATTEMPTS - 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(emailOtpCreate).not.toHaveBeenCalled();
  });

  it("allows only one concurrent verifier to consume a valid challenge", async () => {
    const bcrypt = await import("bcryptjs");
    const codeHash = await bcrypt.default.hash("123456", 4);
    emailOtpFindFirst.mockResolvedValue({
      id: "otp-1",
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    emailOtpUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(verifyOtp("Alice@Stanford.edu", "123456")).resolves.toEqual({
      ok: true,
    });
    await expect(verifyOtp("Alice@Stanford.edu", "123456")).resolves.toEqual({
      ok: false,
      reason: "no_request",
    });
  });

  it("increments mismatch attempts with an unconsumed, unexpired CAS", async () => {
    const bcrypt = await import("bcryptjs");
    const codeHash = await bcrypt.default.hash("123456", 4);
    emailOtpFindFirst.mockResolvedValue({
      id: "otp-1",
      codeHash,
      attempts: 2,
      expiresAt: new Date(Date.now() + 60_000),
    });
    emailOtpUpdateMany.mockResolvedValue({ count: 1 });

    await expect(verifyOtp("alice@stanford.edu", "000000")).resolves.toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(emailOtpUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "otp-1",
        consumedAt: null,
        attempts: { lt: OTP_MAX_ATTEMPTS },
      }),
      data: { attempts: { increment: 1 } },
    });
  });
});
