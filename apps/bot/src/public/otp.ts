import bcrypt from "bcryptjs";
import { prisma } from "@gennety/db";
import { generateOtp, OTP_LENGTH, OTP_TTL_MS } from "@gennety/shared";
import { sendOtpEmail } from "../services/email.js";

const MAX_ATTEMPTS = 5;

/**
 * Create a one-time code, persist its bcrypt hash, and email the raw code
 * to the user. Older unconsumed codes for the same email are left in place
 * but will be ignored once a newer row exists (we always look up the latest).
 */
export async function createAndSendOtp(
  email: string,
  send: (email: string, code: string) => Promise<void> = sendOtpEmail,
): Promise<void> {
  const code = generateOtp(OTP_LENGTH);
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.emailOtp.create({
    data: { email: email.toLowerCase(), codeHash, expiresAt },
  });

  await send(email, code);
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
  if (latest.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "exhausted" };

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
