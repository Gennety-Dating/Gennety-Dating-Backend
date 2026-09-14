import { createHmac } from "node:crypto";
import type { Api, RawApi } from "grammy";
import { prisma, type Prisma, type UserStatus } from "@gennety/db";
import { env } from "../config.js";
import { revokeAllSessions } from "../public/jwt.js";
import {
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
  type CancelledPartner,
} from "./cancel-in-flight-matches.js";
import { notifyFounderSafetyRestoreFailed } from "./founder-notify.js";
import { getMainBotApi } from "./main-bot-api.js";
import { isModerationLockedStatus } from "./user-status.js";

/**
 * Safety continuity across account deletion (A13-H14, decision 2026-09-14).
 *
 * Deleting an account used to cascade its ban, its strikes, and every report and
 * block filed against it. The same person could then press /start with the same
 * Telegram account (or sign in with the same phone or email) and come back with
 * a clean record — straight back into the pool of the person who reported or
 * blocked them. Two halves close that:
 *
 *  - **`writeSafetyTombstones`** runs inside the deletion transaction. When the
 *    account has something to carry, it writes one `SafetyTombstone` per
 *    identity it had and stamps `reports.reported_former_id` /
 *    `user_blocks.blocked_former_id` with the id that is about to disappear.
 *  - **`restoreSafetyHistory`** runs whenever an identity becomes attached to an
 *    account. A tombstone for that identity puts the history back: the reports
 *    and blocks are relinked, the strictest moderation status and the highest
 *    strike count are restored, and a restored lock revokes sessions and cancels
 *    in-flight matches exactly as moderation itself would.
 *
 * **Nothing is stored in the clear.** The identity is `HMAC-SHA256("<kind>:<value>")`
 * under a key derived from `JWT_SECRET` with a fixed label, so no new secret is
 * needed. Rotating `JWT_SECRET` orphans every existing tombstone: lookups stop
 * matching, which degrades to the pre-fix behaviour and can never match the
 * wrong person. Without a `JWT_SECRET` (a local run) nothing is written or
 * looked up — a weakly keyed hash of a phone number is worse than none.
 */

export type SafetyIdentityKind = "telegram" | "phone" | "email";

/** The identity columns of a user row that a tombstone can be keyed on. */
export interface SafetyIdentitySource {
  telegramId: bigint;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  email: string | null;
  isEmailVerified: boolean;
}

export interface SafetyIdentity {
  kind: SafetyIdentityKind;
  identityHash: string;
}

/** Bumping the label is a deliberate, total reset of every tombstone. */
const TOMBSTONE_KEY_LABEL = "safety-tombstone/v1";

const IDENTITY_SELECT = {
  telegramId: true,
  phone: true,
  phoneVerifiedAt: true,
  email: true,
  isEmailVerified: true,
} as const satisfies Prisma.UserSelect;

/**
 * Moderation statuses a tombstone carries, strictest last. `suspended` only
 * counts while its end is still ahead — an elapsed suspension is not a
 * restriction any more, and restoring it would suspend someone for nothing.
 */
const STATUS_RANK: Partial<Record<UserStatus, number>> = {
  suspended: 1,
  pending_investigation: 2,
  banned: 3,
};

/**
 * Every identity of `user` a tombstone may be keyed on, hashed. Only identities
 * the account PROVED: a positive Telegram id (a negative one is a synthetic
 * placeholder for an app-only account), a phone with `phoneVerifiedAt`, an email
 * with `isEmailVerified`. An unproven value could be someone else's, and keying
 * on it would let a stranger inherit — or erase — another person's history.
 */
export function safetyIdentitiesOf(
  user: SafetyIdentitySource,
  secret: string = env.JWT_SECRET,
): SafetyIdentity[] {
  if (!secret) return [];
  const key = createHmac("sha256", secret).update(TOMBSTONE_KEY_LABEL).digest();
  const hash = (kind: SafetyIdentityKind, value: string): SafetyIdentity => ({
    kind,
    identityHash: createHmac("sha256", key).update(`${kind}:${value}`).digest("hex"),
  });

  const identities: SafetyIdentity[] = [];
  if (user.telegramId > 0n) identities.push(hash("telegram", user.telegramId.toString()));
  const phone = user.phone?.trim();
  if (phone && user.phoneVerifiedAt) identities.push(hash("phone", phone));
  const email = user.email?.trim().toLowerCase();
  if (email && user.isEmailVerified) identities.push(hash("email", email));
  return identities;
}

export interface SafetyTombstoneWrite {
  tombstones: number;
  reportsKept: number;
  blocksKept: number;
  /** Reports/blocks against an account with no identity to key them on. */
  reportsDropped: number;
  blocksDropped: number;
}

type TombstoneWriteDb = Pick<
  Prisma.TransactionClient,
  "user" | "report" | "userBlock" | "safetyTombstone"
>;

/**
 * Capture what must outlive the account `userId`. Call INSIDE the deletion
 * transaction, before the user row is deleted — the stamps and the tombstones
 * have to commit with the deletion or not at all, or a crash between them
 * leaves reports pointing at nobody and no way to relink them.
 *
 * Carries only when there is something to carry: a moderation status, strikes,
 * or a report or block filed AGAINST the account. Reports the account FILED and
 * blocks it DREW are not this function's business: the former keep their row
 * with `reporterId` nulled by the schema, the latter cascade away with it.
 *
 * An account with nothing provable to key on (no positive Telegram id, verified
 * phone or verified email — or no `JWT_SECRET`) cannot be recognised again, so
 * its reports and blocks-against are deleted here, exactly as the cascade used
 * to: a row that can never be relinked protects nobody.
 */
export async function writeSafetyTombstones(
  db: TombstoneWriteDb,
  userId: string,
  secret: string = env.JWT_SECRET,
): Promise<SafetyTombstoneWrite> {
  const result: SafetyTombstoneWrite = {
    tombstones: 0,
    reportsKept: 0,
    blocksKept: 0,
    reportsDropped: 0,
    blocksDropped: 0,
  };

  // Tombstones already applied to THIS account are superseded by what is
  // written below: its current state already contains them, including any
  // moderator decision taken since (a lifted ban must not come back through
  // the older row the next time this person registers).
  await db.safetyTombstone.deleteMany({ where: { restoredToUserId: userId } });

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { ...IDENTITY_SELECT, status: true, strikes: true, suspendedUntil: true },
  });
  if (!user) return result;

  const [reportsAgainst, blocksAgainst] = await Promise.all([
    db.report.count({ where: { reportedId: userId } }),
    db.userBlock.count({ where: { blockedId: userId } }),
  ]);
  const moderated = STATUS_RANK[user.status] !== undefined;
  const carries = moderated || user.strikes > 0 || reportsAgainst > 0 || blocksAgainst > 0;
  if (!carries) return result;

  const identities = safetyIdentitiesOf(user, secret);
  if (identities.length === 0) {
    const [reports, blocks] = await Promise.all([
      db.report.deleteMany({ where: { reportedId: userId } }),
      db.userBlock.deleteMany({ where: { blockedId: userId } }),
    ]);
    result.reportsDropped = reports.count;
    result.blocksDropped = blocks.count;
    console.warn(
      `[safety-tombstone] user=${userId} had safety history but no keyable identity` +
        (secret ? "" : " (JWT_SECRET unset)") +
        ` — reports=${reports.count} blocks=${blocks.count} dropped with the account`,
    );
    return result;
  }

  const created = await db.safetyTombstone.createMany({
    data: identities.map((identity) => ({
      identityHash: identity.identityHash,
      kind: identity.kind,
      formerUserId: userId,
      status: moderated ? user.status : null,
      suspendedUntil: user.status === "suspended" ? user.suspendedUntil : null,
      strikes: user.strikes,
    })),
  });
  const [reports, blocks] = await Promise.all([
    db.report.updateMany({ where: { reportedId: userId }, data: { reportedFormerId: userId } }),
    db.userBlock.updateMany({ where: { blockedId: userId }, data: { blockedFormerId: userId } }),
  ]);
  result.tombstones = created.count;
  result.reportsKept = reports.count;
  result.blocksKept = blocks.count;
  return result;
}

export interface SafetyRestoreResult {
  /** Whether any tombstone applied — false for the overwhelmingly common case. */
  applied: boolean;
  /** The moderation status put back on the account, when one was. */
  statusRestored: UserStatus | null;
  strikesRestored: number | null;
  reportsRelinked: number;
  blocksRelinked: number;
  cancelledMatches: number;
}

const NOTHING_RESTORED: SafetyRestoreResult = {
  applied: false,
  statusRestored: null,
  strikesRestored: null,
  reportsRelinked: 0,
  blocksRelinked: 0,
  cancelledMatches: 0,
};

/**
 * Put a returning person's safety history back onto account `userId`.
 *
 * Idempotent, and deliberately so: every identity-attach path calls it, often
 * more than once for the same person. A tombstone applied to an account is
 * marked `restoredToUserId` and is skipped for that account from then on — so a
 * moderator lifting a restored ban is never overruled when the same person
 * later verifies another identity. A DIFFERENT account reaching the same
 * identity gets the status again (a second account is exactly the evasion this
 * exists to stop); reports and blocks move only once, to the first account.
 *
 * Status: the strictest of the account's own and the tombstones' wins
 * (`banned` > `pending_investigation` > a still-running `suspended`, the later
 * end of two suspensions); strikes take the maximum. A status that becomes a
 * lock revokes every refresh session and cancels in-flight matches in the same
 * transaction, as `services/moderation.ts` does; partner effects run after
 * commit.
 */
export async function restoreSafetyHistory(
  userId: string,
  options: { secret?: string; api?: Api<RawApi> | null; now?: Date } = {},
): Promise<SafetyRestoreResult> {
  const secret = options.secret ?? env.JWT_SECRET;
  if (!secret) return NOTHING_RESTORED;
  const now = options.now ?? new Date();

  const identitySource = await prisma.user.findUnique({
    where: { id: userId },
    select: IDENTITY_SELECT,
  });
  if (!identitySource) return NOTHING_RESTORED;
  const hashes = safetyIdentitiesOf(identitySource, secret).map((identity) => identity.identityHash);
  if (hashes.length === 0) return NOTHING_RESTORED;

  const applicable = {
    identityHash: { in: hashes },
    formerUserId: { not: userId },
    OR: [{ restoredToUserId: null }, { restoredToUserId: { not: userId } }],
  } satisfies Prisma.SafetyTombstoneWhereInput;

  // Cheap probe outside any transaction: nearly every call finds nothing, and
  // must not pay for a row lock to learn it.
  const probe = await prisma.safetyTombstone.findFirst({ where: applicable, select: { id: true } });
  if (!probe) return NOTHING_RESTORED;

  let cancelled: CancelledPartner[] = [];
  const result = await prisma.$transaction(async (tx) => {
    // Serialise concurrent restores for one account (two identities attached
    // at once); the second re-reads and finds the tombstones already applied.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;

    const tombstones = await tx.safetyTombstone.findMany({
      where: applicable,
      select: { formerUserId: true, status: true, suspendedUntil: true, strikes: true },
    });
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, strikes: true, suspendedUntil: true },
    });
    if (tombstones.length === 0 || !user) return NOTHING_RESTORED;

    const formerIds = [...new Set(tombstones.map((row) => row.formerUserId))];

    const reports = await tx.report.updateMany({
      where: { reportedId: null, reportedFormerId: { in: formerIds } },
      data: { reportedId: userId, reportedFormerId: null },
    });

    // `(blocker_id, blocked_id)` is unique. Relinking would collide where the
    // blocker already blocks this account, or where one blocker had blocked
    // two former accounts of the same person — keep one row per blocker.
    await tx.$executeRaw`
      DELETE FROM user_blocks f
       WHERE f.blocked_id IS NULL
         AND f.blocked_former_id = ANY(${formerIds}::uuid[])
         AND (
           f.blocker_id = ${userId}::uuid
           OR EXISTS (
             SELECT 1 FROM user_blocks e
              WHERE e.blocker_id = f.blocker_id AND e.blocked_id = ${userId}::uuid
           )
           OR EXISTS (
             SELECT 1 FROM user_blocks o
              WHERE o.blocker_id = f.blocker_id
                AND o.blocked_id IS NULL
                AND o.blocked_former_id = ANY(${formerIds}::uuid[])
                AND o.id < f.id
           )
         )
    `;
    const blocks = await tx.userBlock.updateMany({
      where: { blockedId: null, blockedFormerId: { in: formerIds } },
      data: { blockedId: userId, blockedFormerId: null },
    });

    const strictest = strictestTombstone(tombstones, now);
    const currentRank = STATUS_RANK[user.status] ?? 0;
    const data: Prisma.UserUpdateInput = {};
    let statusRestored: UserStatus | null = null;
    if (strictest && strictest.rank > currentRank) {
      statusRestored = strictest.status;
      data.status = strictest.status;
      if (strictest.status === "suspended") data.suspendedUntil = strictest.suspendedUntil;
    } else if (
      strictest?.status === "suspended" &&
      user.status === "suspended" &&
      strictest.suspendedUntil &&
      (!user.suspendedUntil || strictest.suspendedUntil > user.suspendedUntil)
    ) {
      data.suspendedUntil = strictest.suspendedUntil;
    }
    const tombstoneStrikes = Math.max(...tombstones.map((row) => row.strikes));
    const strikesRestored = tombstoneStrikes > user.strikes ? tombstoneStrikes : null;
    if (strikesRestored !== null) data.strikes = strikesRestored;
    if (Object.keys(data).length > 0) {
      await tx.user.update({ where: { id: userId }, data });
    }

    if (statusRestored && isModerationLockedStatus(statusRestored)) {
      await revokeAllSessions(userId, tx);
      cancelled = await claimInFlightMatchCancellations(userId, tx, { strict: true });
    }

    // Every tombstone of these former accounts — not only the identities that
    // matched — so this account verifying another of them later is a no-op.
    await tx.safetyTombstone.updateMany({
      where: { formerUserId: { in: formerIds } },
      data: { restoredToUserId: userId, restoredAt: now },
    });

    return {
      applied: true,
      statusRestored,
      strikesRestored,
      reportsRelinked: reports.count,
      blocksRelinked: blocks.count,
      cancelledMatches: cancelled.length,
    } satisfies SafetyRestoreResult;
  });

  if (result.applied) {
    console.info(
      `[safety-tombstone] restored user=${userId} status=${result.statusRestored ?? "-"} ` +
        `strikes=${result.strikesRestored ?? "-"} reports=${result.reportsRelinked} ` +
        `blocks=${result.blocksRelinked} cancelledMatches=${result.cancelledMatches}`,
    );
  }
  if (cancelled.length > 0) {
    await deliverCancelledPartnerEffects(cancelled, options.api ?? getMainBotApi());
  }
  return result;
}

function strictestTombstone(
  tombstones: ReadonlyArray<{ status: UserStatus | null; suspendedUntil: Date | null }>,
  now: Date,
): { status: UserStatus; rank: number; suspendedUntil: Date | null } | null {
  let best: { status: UserStatus; rank: number; suspendedUntil: Date | null } | null = null;
  for (const row of tombstones) {
    if (!row.status) continue;
    const rank = STATUS_RANK[row.status];
    if (rank === undefined) continue;
    if (row.status === "suspended" && (!row.suspendedUntil || row.suspendedUntil <= now)) continue;
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank &&
        row.suspendedUntil !== null &&
        (best.suspendedUntil === null || row.suspendedUntil > best.suspendedUntil))
    ) {
      best = { status: row.status, rank, suspendedUntil: row.suspendedUntil };
    }
  }
  return best;
}

/**
 * `restoreSafetyHistory` for the call sites where the identity has ALREADY been
 * committed — a created account, a verified phone, a claimed email, a login.
 *
 * The attach is not undone when the restore fails: the person did nothing
 * wrong by logging in, and a half-failed sign-in helps nobody. But a failed
 * restore can leave a banned person with a clean record, so it is never
 * swallowed quietly either: it is logged and the founder gets the user id to
 * re-run it. Returns the result, or `null` when the restore failed.
 */
export async function restoreSafetyHistoryAfterAttach(
  userId: string,
  source: string,
): Promise<SafetyRestoreResult | null> {
  try {
    return await restoreSafetyHistory(userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[safety-tombstone] restore failed user=${userId} source=${source}: ${message}`);
    await notifyFounderSafetyRestoreFailed({ userId, source, error: message });
    return null;
  }
}
