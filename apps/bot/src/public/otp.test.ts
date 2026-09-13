import { beforeEach, describe, expect, it, vi } from "vitest";

const emailOtpCreate = vi.fn();
const emailOtpDelete = vi.fn();
const emailOtpFindFirst = vi.fn();
const emailOtpUpdateMany = vi.fn();
const emailOtpAggregate = vi.fn();
const userFindUnique = vi.fn();
const queryRawUnsafe = vi.fn();

const prismaMock = {
  emailOtp: {
    create: emailOtpCreate,
    delete: emailOtpDelete,
    findFirst: emailOtpFindFirst,
    updateMany: emailOtpUpdateMany,
    aggregate: emailOtpAggregate,
  },
  user: {
    findUnique: userFindUnique,
  },
  $executeRawUnsafe: queryRawUnsafe,
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
const { EMAIL_OTP_DAILY_CAP, EMAIL_OTP_DAILY_FAILED_ATTEMPTS_CAP } = await import(
  "@gennety/shared"
);

beforeEach(() => {
  emailOtpCreate.mockReset();
  emailOtpDelete.mockReset();
  emailOtpFindFirst.mockReset();
  emailOtpUpdateMany.mockReset();
  emailOtpAggregate.mockReset();
  userFindUnique.mockReset();
  queryRawUnsafe.mockReset();
  // A fresh address: nothing issued, nothing guessed in the last 24 hours.
  emailOtpAggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { attempts: null } });
  userFindUnique.mockResolvedValue(null);
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

  it("deletes the challenge when email delivery fails, so a retry is not blocked", async () => {
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpCreate.mockResolvedValue({
      id: "otp-1",
      createdAt: new Date(),
    });
    emailOtpDelete.mockResolvedValue({});
    const send = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    await expect(
      createAndSendOtp("alice@stanford.edu", { plusAlias: "refuse", send }),
    ).rejects.toThrow(
      "provider unavailable",
    );
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "alice@stanford.edu",
    );
    // Delivery now happens after the commit (so the pooled connection is not
    // held across a 15s HTTP call), so an un-delivered challenge is cleaned up
    // by a compensating delete instead of a transaction rollback.
    expect(emailOtpDelete).toHaveBeenCalledWith({ where: { id: "otp-1" } });
  });

  it("commits the challenge BEFORE sending, so no DB connection is held across the send", async () => {
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpCreate.mockResolvedValue({ id: "otp-2", createdAt: new Date() });
    const order: string[] = [];
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) => {
        const out = await callback(prismaMock);
        order.push("commit");
        return out;
      },
    );
    const send = vi.fn().mockImplementation(async () => {
      order.push("send");
    });

    await createAndSendOtp("alice@stanford.edu", { plusAlias: "refuse", send });

    expect(order).toEqual(["commit", "send"]);
  });

  it("returns the existing challenge without sending during the cooldown", async () => {
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + 60_000);
    emailOtpFindFirst.mockResolvedValue({ createdAt, expiresAt, attempts: 1 });
    const send = vi.fn();

    await expect(
      createAndSendOtp("Alice@Stanford.edu", { plusAlias: "refuse", send }),
    ).resolves.toMatchObject({
      ok: true,
      sent: false,
      state: {
        status: "pending",
        expiresAt,
        attemptsRemaining: OTP_MAX_ATTEMPTS - 1,
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(emailOtpCreate).not.toHaveBeenCalled();
  });

  it("reports a delivered code as sent", async () => {
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpCreate.mockResolvedValue({ id: "otp-3", createdAt: new Date() });
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(
      createAndSendOtp("alice@stanford.edu", { plusAlias: "refuse", send }),
    ).resolves.toMatchObject({ ok: true, sent: true, state: { status: "pending" } });
    expect(send).toHaveBeenCalledWith("alice@stanford.edu", expect.stringMatching(/^\d{6}$/));
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

/**
 * Audit A13-M9. Before this the only per-address limits were in-memory and keyed
 * on address + IP, so a pool of IPs (or a restart) reset them, and an exhausted
 * code was replaced by a fresh one on the very next request.
 */
describe("durable per-address budget", () => {
  it("keeps the cooldown after an exhausted code instead of issuing a new one", async () => {
    const createdAt = new Date();
    emailOtpFindFirst.mockResolvedValue({
      createdAt,
      expiresAt: new Date(Date.now() + 60_000),
      attempts: OTP_MAX_ATTEMPTS,
    });
    const send = vi.fn();

    await expect(
      createAndSendOtp("alice@stanford.edu", { plusAlias: "refuse", send }),
    ).resolves.toEqual({
      ok: true,
      sent: false,
      state: {
        status: "exhausted",
        expiresAt: expect.any(Date),
        resendAvailableAt: new Date(createdAt.getTime() + OTP_RESEND_COOLDOWN_MS),
        attemptsRemaining: 0,
      },
    });
    expect(emailOtpCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses once the address has been issued the daily cap of codes", async () => {
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpAggregate.mockResolvedValue({
      _count: { _all: EMAIL_OTP_DAILY_CAP },
      _sum: { attempts: 0 },
    });
    const send = vi.fn();

    await expect(
      createAndSendOtp("alice@stanford.edu", { plusAlias: "refuse", send }),
    ).resolves.toEqual({ ok: false, reason: "daily_cap" });
    expect(emailOtpCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // Counted over the rolling window, for this address only.
    expect(emailOtpAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "alice@stanford.edu", createdAt: { gt: expect.any(Date) } },
      }),
    );
  });

  it("refuses once the address has absorbed the daily cap of wrong guesses", async () => {
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpAggregate.mockResolvedValue({
      _count: { _all: 4 },
      _sum: { attempts: EMAIL_OTP_DAILY_FAILED_ATTEMPTS_CAP },
    });
    const send = vi.fn();

    await expect(
      createAndSendOtp("alice@stanford.edu", { plusAlias: "refuse", send }),
    ).resolves.toEqual({ ok: false, reason: "daily_cap" });
    expect(emailOtpCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("plus-addressed emails", () => {
  it("refuses a tagged address on a claim rail before touching the challenge table", async () => {
    const send = vi.fn();
    await expect(
      createAndSendOtp("alice+2@stanford.edu", { plusAlias: "refuse", send }),
    ).resolves.toEqual({ ok: false, reason: "plus_alias" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // `refuse` never asks who holds the address — no membership probe.
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a tagged address on the login rail when no verified account holds it", async () => {
    userFindUnique.mockResolvedValue({ isEmailVerified: false });
    await expect(
      createAndSendOtp("alice+2@stanford.edu", {
        plusAlias: "existing_verified_only",
        send: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, reason: "plus_alias" });
  });

  it("still lets an account verified on a tagged address log in", async () => {
    userFindUnique.mockResolvedValue({ isEmailVerified: true });
    emailOtpFindFirst.mockResolvedValue(null);
    emailOtpCreate.mockResolvedValue({ id: "otp-9", createdAt: new Date() });
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(
      createAndSendOtp("Alice+2@Stanford.edu", { plusAlias: "existing_verified_only", send }),
    ).resolves.toMatchObject({ ok: true, sent: true });
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { email: "alice+2@stanford.edu" },
      select: { isEmailVerified: true },
    });
  });
});
