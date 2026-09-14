import { prisma } from "@gennety/db";
import { restoreSafetyHistoryAfterAttach } from "./safety-tombstone.js";
import {
  createAndSendOtp,
  discardOtpDelivery,
  type OtpRequestResult,
} from "../public/otp.js";

/**
 * Who may hold a university address on `User.email`, and when.
 *
 * The rule (audit A13-C1): **`User.email` only ever holds an address its row
 * has PROVEN.** An unproven address lives in the OTP challenge (`EmailOtp`,
 * keyed by the address itself) and reaches the user row in the same write that
 * sets `isEmailVerified: true`, after the code checked out.
 *
 * It used to be written at request time. `User.email` is the unique login key of
 * the native app, and `findOrCreateMobileUser` reused whatever row held the
 * address — so typing a stranger's university email into the Telegram Mini App,
 * with no code at all, parked it on the attacker's row, and the real owner's
 * first iOS sign-in flipped that row to verified and logged them into an
 * account the attacker controls through Telegram.
 *
 * Production may still carry rows written under the old rule (an address with
 * `isEmailVerified: false`). Nothing here treats such a row as owning its
 * address: whoever proves the mailbox detaches it.
 */

/** The patch that records `email` as proven on a user row. */
export interface VerifiedEmailPatch {
  email: string;
  universityDomain: string;
  isEmailVerified: true;
  /** Registration v2: a verified university email IS the student track. */
  registrationTrack: "student";
}

export type VerifiedEmailClaim<T> =
  | { ok: true; value: T }
  /**
   * Another account already holds this address as VERIFIED, or won a race to
   * it a moment ago (a unique-constraint collision on the write). One mailbox,
   * one account.
   */
  | { ok: false; reason: "linked_elsewhere" };

export function verifiedEmailPatch(email: string): VerifiedEmailPatch {
  const normalised = email.toLowerCase();
  return {
    email: normalised,
    universityDomain: normalised.slice(normalised.lastIndexOf("@") + 1),
    isEmailVerified: true,
    registrationTrack: "student",
  };
}

/**
 * Take an address off any row that holds it without having proven it.
 *
 * Compare-and-set on the row still being unverified: if the holder finished a
 * genuine verification between our read and this write, it keeps the address
 * and the caller's own write collides instead — never silently undone.
 */
export async function detachUnverifiedEmail(
  email: string,
  keepUserId: string | null,
): Promise<void> {
  await prisma.user.updateMany({
    where: {
      email: email.toLowerCase(),
      isEmailVerified: false,
      ...(keepUserId ? { id: { not: keepUserId } } : {}),
    },
    data: { email: null, universityDomain: null },
  });
}

/**
 * Write a JUST-PROVEN address onto `userId`'s row.
 *
 * Call only after the code for `email` checked out (or the demo's documented
 * bypass). `write` performs the actual update so each caller keeps its own
 * `select` and side fields; it receives the verified patch to spread in.
 *
 * A verified holder elsewhere refuses up front. A unique-constraint collision
 * on the write is the same outcome reached by a race — two Telegram accounts
 * proving one mailbox at once — and is reported as such rather than surfacing
 * as a 500.
 */
export async function claimVerifiedEmail<T>(
  userId: string,
  email: string,
  write: (patch: VerifiedEmailPatch) => Promise<T>,
): Promise<VerifiedEmailClaim<T>> {
  const patch = verifiedEmailPatch(email);
  const holder = await prisma.user.findUnique({
    where: { email: patch.email },
    select: { id: true, isEmailVerified: true },
  });
  if (holder && holder.id !== userId) {
    if (holder.isEmailVerified) return { ok: false, reason: "linked_elsewhere" };
    await detachUnverifiedEmail(patch.email, userId);
  }

  let value: T;
  try {
    value = await write(patch);
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "linked_elsewhere" };
    throw err;
  }
  // The address is now proven on this row. If it belonged to a deleted account
  // with a safety history, that history comes back here (A13-H14) — after the
  // write, never instead of it; a failed restore is alerted, not thrown.
  await restoreSafetyHistoryAfterAttach(userId, "email:claim");
  return { ok: true, value };
}

/**
 * Start a verification that would ATTACH `email` to `userId` (the Telegram
 * Mini App and the onboarding agent — not the native login, which signs into
 * whichever account the address proves).
 *
 * An address already verified on a different account gets the full state
 * machine with delivery discarded (`discardOtpDelivery`): the caller's answer
 * is indistinguishable from a real send, no stranger's mailbox receives a code
 * it never asked for, and the verify step fails like any wrong code. Tagged
 * addresses are refused outright on these rails.
 */
export async function requestEmailClaimCode(
  userId: string,
  email: string,
  send?: (email: string, code: string) => Promise<void>,
): Promise<OtpRequestResult> {
  const normalised = email.toLowerCase();
  const holder = await prisma.user.findUnique({
    where: { email: normalised },
    select: { id: true, isEmailVerified: true },
  });
  const linkedElsewhere = Boolean(holder && holder.id !== userId && holder.isEmailVerified);
  return createAndSendOtp(normalised, {
    plusAlias: "refuse",
    ...(linkedElsewhere ? { send: discardOtpDelivery } : send ? { send } : {}),
  });
}

/** Prisma P2002. Structural, like the other copies, so no client import is needed. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}
