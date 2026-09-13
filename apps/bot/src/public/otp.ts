import bcrypt from "bcryptjs";
import { prisma } from "@gennety/db";
import {
  EMAIL_OTP_BUDGET_WINDOW_MS,
  EMAIL_OTP_DAILY_CAP,
  EMAIL_OTP_DAILY_FAILED_ATTEMPTS_CAP,
  generateOtp,
  hasPlusAddressTag,
  OTP_LENGTH,
  OTP_TTL_MS,
} from "@gennety/shared";
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
 * What to do with a `name+tag@` address (see `hasPlusAddressTag`).
 *
 * - `existing_verified_only` — the LOGIN rail (`POST /v1/auth/otp/request`).
 *   An account that was verified on such an address before this rule existed
 *   must still be able to sign in, so the tag is accepted only when a verified
 *   account already holds exactly that string.
 * - `refuse` — the rails that ATTACH an address to the account asking
 *   (Telegram Mini App, onboarding agent). There the exception could only ever
 *   end in "linked to another account", and granting it would turn the refusal
 *   into a membership probe for tagged addresses.
 */
export type PlusAliasPolicy = "existing_verified_only" | "refuse";

export type OtpRequestResult =
  | {
      ok: true;
      /**
       * False when a live code for this address was issued less than the resend
       * cooldown ago: nothing was sent and `state` describes that earlier code.
       * The Mini App answers this with 429 `otp-cooldown`; the login rail keeps
       * answering 200 exactly as it always has.
       */
      sent: boolean;
      state: OtpChallengeState;
    }
  | {
      ok: false;
      /**
       * `plus_alias` — a tagged address the policy refuses.
       * `daily_cap`  — this address spent its durable 24h budget: too many codes
       *                issued, or too many wrong guesses across them.
       */
      reason: "plus_alias" | "daily_cap";
    };

export interface CreateAndSendOtpOptions {
  plusAlias: PlusAliasPolicy;
  /** Delivery. Defaults to the real email sender; tests and callers inject. */
  send?: (email: string, code: string) => Promise<void>;
}

/**
 * Deliberately delivers nothing.
 *
 * The Telegram claim rails answer a request for an address that already
 * belongs to ANOTHER verified account exactly as they answer any other request
 * — same shape, same cooldown, same daily budget — because a distinct answer
 * told whoever asked that the address has a dating account (audit A13-M10).
 * The row is still written, so the state machine behind those answers is the
 * real one, but the code goes nowhere: nobody is mailed a code they did not ask
 * for, and the verify step can only fail.
 */
export const discardOtpDelivery = async (): Promise<void> => {};

/**
 * Create a one-time code, persist its bcrypt hash, and email the raw code
 * to the user. Older unconsumed codes for the same email are left in place
 * but will be ignored once a newer row exists (we always look up the latest).
 */
export async function createAndSendOtp(
  email: string,
  options: CreateAndSendOtpOptions,
): Promise<OtpRequestResult> {
  const normalisedEmail = email.toLowerCase();
  const send = options.send ?? sendOtpEmail;

  if (hasPlusAddressTag(normalisedEmail)) {
    const allowed =
      options.plusAlias === "existing_verified_only" &&
      (await prisma.user.findUnique({
        where: { email: normalisedEmail },
        select: { isEmailVerified: true },
      }))?.isEmailVerified === true;
    if (!allowed) return { ok: false, reason: "plus_alias" };
  }

  // The cooldown check and challenge creation must be serialized per email.
  // A plain find-then-create lets simultaneous requests all send a code. A
  // transaction-scoped PostgreSQL advisory lock works across every Node/PM2
  // process without a schema change.
  //
  // Delivery deliberately happens OUTSIDE this transaction. It used to be
  // inside it, which meant every OTP request held a pooled DB connection AND
  // the advisory lock for the duration of an outbound HTTP call — up to the
  // email client's 15s timeout. Prisma's default pool on the production droplet
  // is a handful of connections, so a slow email provider (or simply enough
  // concurrent signups from distinct emails, which the per-email rate limiter
  // does not bound) starved the pool and stalled the bot, both APIs, and every
  // cron worker. The anti-double-send property comes from the lock plus the
  // persisted row, not from holding the connection across the network call, so
  // nothing is lost by committing first and sending after.
  const created = await prisma.$transaction(
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
      // The cooldown holds for an EXHAUSTED code too. It used to be skipped
      // there (`attempts < OTP_MAX_ATTEMPTS` was part of this test), so five
      // wrong guesses bought a fresh code on the very next request — the
      // per-code attempt cap bounded nothing but the pace of one loop.
      if (
        existing &&
        existing.expiresAt > now &&
        now.getTime() - existing.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS
      ) {
        return {
          kind: "cooldown" as const,
          state: {
            status:
              existing.attempts >= OTP_MAX_ATTEMPTS
                ? ("exhausted" as const)
                : ("pending" as const),
            expiresAt: existing.expiresAt,
            resendAvailableAt: new Date(
              existing.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS,
            ),
            attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - existing.attempts),
          },
        };
      }

      // Durable per-address budget (audit A13-M9). The limiters in front of
      // this function live in memory and are keyed on address + IP, so a pool
      // of addresses — or one restart — reset them. These counts come from the
      // rows themselves, under the same lock, so concurrent requests cannot
      // race past them either. One aggregate answers both questions and rides
      // the existing `(email, createdAt)` index.
      const budget = await tx.emailOtp.aggregate({
        where: {
          email: normalisedEmail,
          createdAt: { gt: new Date(now.getTime() - EMAIL_OTP_BUDGET_WINDOW_MS) },
        },
        _count: { _all: true },
        _sum: { attempts: true },
      });
      if (
        budget._count._all >= EMAIL_OTP_DAILY_CAP ||
        (budget._sum.attempts ?? 0) >= EMAIL_OTP_DAILY_FAILED_ATTEMPTS_CAP
      ) {
        return { kind: "daily_cap" as const };
      }

      const code = generateOtp(OTP_LENGTH);
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
      const challenge = await tx.emailOtp.create({
        data: { email: normalisedEmail, codeHash, expiresAt },
      });
      return {
        kind: "created" as const,
        pending: { id: challenge.id, code },
        state: {
          status: "pending" as const,
          expiresAt,
          resendAvailableAt: new Date(
            challenge.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS,
          ),
          attemptsRemaining: OTP_MAX_ATTEMPTS,
        },
      };
    },
    { timeout: 20_000 },
  );

  if (created.kind === "daily_cap") return { ok: false, reason: "daily_cap" };
  if (created.kind === "cooldown") return { ok: true, sent: false, state: created.state };

  // Send after the commit. On failure, delete the row we just wrote so the
  // caller's retry is not blocked by its own un-delivered challenge — the same
  // net effect the old in-transaction rollback had, without holding a
  // connection across the network call.
  try {
    await send(email, created.pending.code);
  } catch (err) {
    await prisma.emailOtp
      .delete({ where: { id: created.pending.id } })
      .catch(() => {});
    throw err;
  }

  return { ok: true, sent: true, state: created.state };
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
