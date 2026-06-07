import bcrypt from "bcryptjs";
import { prisma } from "@gennety/db";
import { generateOtp, OTP_LENGTH, OTP_TTL_MS } from "@gennety/shared";
import { sendOtpEmail } from "../services/email.js";

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30_000;

export type OtpChallengeState = {
  status: "none" | "pending" | "expired" | "exhausted";
  expiresAt: Date | null;
  resendAvailableAt: Date | null;
  attemptsRemaining: number;
};

/**
 * Create a one-time code, persist its bcrypt hash, and email the raw code
 * to the user. Older unconsumed codes for the same email are left in place
 * but will be ignored once a newer row exists (we always look up the latest).
 */
export async function createAndSendOtp(
  email: string,
  send: (email: string, code: string) => Promise<void> = sendOtpEmail,
): Promise<OtpChallengeState> {
  const code = generateOtp(OTP_LENGTH);
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  const challenge = await prisma.emailOtp.create({
    data: { email: email.toLowerCase(), codeHash, expiresAt },
  });

  try {
    await send(email, code);
  } catch (error) {
    await prisma.emailOtp.delete({ where: { id: challenge.id } }).catch(() => undefined);
    throw error;
  }

  return {
    status: "pending",
    expiresAt,
    resendAvailableAt: new Date(challenge.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS),
    attemptsRemaining: OTP_MAX_ATTEMPTS,
  };
}

export async function getOtpChallengeState(
  email: string | null,
  now = new Date(),
): Promise<OtpChallengeState> {
  if (!email) return emptyChallengeState();

  const latest = await prisma.emailOtp.findFirst({
    where: { email: email.toLowerCase(), consumedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      expiresAt: true,
      attempts: true,
      createdAt: true,
    },
  });

  if (!latest) return emptyChallengeState();

  const base = {
    expiresAt: latest.expiresAt,
    resendAvailableAt: new Date(latest.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS),
    attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - latest.attempts),
  };
  if (latest.attempts >= OTP_MAX_ATTEMPTS) return { status: "exhausted", ...base };
  if (latest.expiresAt <= now) return { status: "expired", ...base };
  return { status: "pending", ...base };
}

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "no_request" | "exhausted" | "mismatch" };

/**
 * Validate a code against the latest unconsumed challenge for this email.
 * Consumes the row on success; increments `attempts` on mismatch. Separate
 * rate limiting lives in middleware — this function assumes it's already
 * gated and focuses on state machine correctness.
 */
export async function verifyOtp(email: string, code: string): Promise<OtpVerifyResult> {
  const normalised = email.toLowerCase();
  const latest = await prisma.emailOtp.findFirst({
    where: { email: normalised, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) return { ok: false, reason: "no_request" };
  if (latest.expiresAt < new Date()) return { ok: false, reason: "expired" };
  if (latest.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "exhausted" };

  const match = await bcrypt.compare(code, latest.codeHash);
  if (!match) {
    await prisma.emailOtp.update({
      where: { id: latest.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "mismatch" };
  }

  await prisma.emailOtp.update({
    where: { id: latest.id },
    data: { consumedAt: new Date() },
  });
  return { ok: true };
}

function emptyChallengeState(): OtpChallengeState {
  return {
    status: "none",
    expiresAt: null,
    resendAvailableAt: null,
    attemptsRemaining: OTP_MAX_ATTEMPTS,
  };
}
