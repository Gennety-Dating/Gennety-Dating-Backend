import { beforeEach, describe, expect, it, vi } from "vitest";

const emailOtpCreate = vi.fn();
const emailOtpDelete = vi.fn();
const emailOtpFindFirst = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    emailOtp: {
      create: emailOtpCreate,
      delete: emailOtpDelete,
      findFirst: emailOtpFindFirst,
      update: vi.fn(),
    },
  },
}));

vi.mock("../services/email.js", () => ({
  sendOtpEmail: vi.fn(),
}));

const {
  createAndSendOtp,
  getOtpChallengeState,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
} = await import("./otp.js");

beforeEach(() => {
  emailOtpCreate.mockReset();
  emailOtpDelete.mockReset();
  emailOtpFindFirst.mockReset();
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

  it("removes a challenge when email delivery fails", async () => {
    emailOtpCreate.mockResolvedValue({
      id: "otp-1",
      createdAt: new Date(),
    });
    emailOtpDelete.mockResolvedValue({ id: "otp-1" });
    const send = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    await expect(createAndSendOtp("alice@stanford.edu", send)).rejects.toThrow(
      "provider unavailable",
    );
    expect(emailOtpDelete).toHaveBeenCalledWith({ where: { id: "otp-1" } });
  });
});
