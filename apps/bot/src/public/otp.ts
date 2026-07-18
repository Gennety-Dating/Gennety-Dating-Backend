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
  const normalisedEmail = email.toLowerCase();

  // The cooldown check and challenge creation must be serialized per email.
  // A plain find-then-create lets simultaneous requests all send a code. A
  // transaction-scoped PostgreSQL advisory lock works across every Node/PM2
  // process without a schema change. Delivery remains inside the bounded
  // transaction (the email client has a 15s timeout), so a failed send rolls
  // the challenge back and a waiting retry can safely create the next one.
  return prisma.$transaction(
    async (tx) => {
      // $executeRawUnsafe, not $queryRawUnsafe: pg_advisory_xact_lock returns
      // `void`, which Prisma 6.19+ refuses to deserialize as a result column
      // (P2010 "Failed to deserialize column of type 'void'"). Execute skips
      // result deserialization entirely — the lock side effect is all we need.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        normalisedEmail,
      );
      const now = new Date();
      const existing = await tx.emailOtp.findFirst({
        where: { email: normalisedEmail, consumedAt: null },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, expiresAt: true, attempts: true },
      });
      if (
        existing &&
        existing.expiresAt > now &&
        existing.attempts < OTP_MAX_ATTEMPTS &&
        now.getTime() - existing.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS
      ) {
        return {
          status: "pending" as const,
          expiresAt: existing.expiresAt,
          resendAvailableAt: new Date(
            existing.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS,
          ),
          attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - existing.attempts),
        };
      }

      const code = generateOtp(OTP_LENGTH);
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
      const challenge = await tx.emailOtp.create({
        data: { email: normalisedEmail, codeHash, expiresAt },
      });
      await send(email, code);
      return {
        status: "pending" as const,
        expiresAt,
        resendAvailableAt: new Date(
          challenge.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS,
        ),
        attemptsRemaining: OTP_MAX_ATTEMPTS,
      };
    },
    { timeout: 20_000 },
  );
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
  const now = new Date();
  const latest = await prisma.emailOtp.findFirst({
    where: { email: normalised, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) return { ok: false, reason: "no_request" };
  if (latest.expiresAt < now) return { ok: false, reason: "expired" };
  if (latest.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "exhausted" };

  const match = await bcrypt.compare(code, latest.codeHash);
  if (!match) {
    await prisma.emailOtp.updateMany({
      where: {
        id: latest.id,
        consumedAt: null,
        attempts: { lt: OTP_MAX_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "mismatch" };
  }

  const consumed = await prisma.emailOtp.updateMany({
    where: {
      id: latest.id,
      consumedAt: null,
      attempts: { lt: OTP_MAX_ATTEMPTS },
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (consumed.count === 0) return { ok: false, reason: "no_request" };
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
