import { prisma } from "@gennety/db";
import { env } from "../config.js";
import {
  IDENTITY_SELECT,
  safetyIdentitiesOf,
  type SafetyIdentityKind,
} from "./identity-hash.js";

/**
 * A returning person: an account whose proven identities belonged to an
 * account that was deleted (decision 2026-10-13). Read from `safety_tombstones`
 * — every deletion of an account with a provable identity leaves at least a
 * bare one (`writeSafetyTombstones`) — so it holds for deletions in the last
 * `SAFETY_TOMBSTONE_RETENTION_MONTHS`.
 */

/**
 * Whether this account's proven identities (Telegram id, verified phone,
 * verified email) belonged to an account that was deleted.
 *
 * Gates only the one-time sign-up gifts (welcome, student, photo, video,
 * promo): deleting and re-registering must not mint them again. Nothing else
 * reads it — a returning person is welcome, just not paid to return. Always
 * false in the demo (see `writeSafetyTombstones`) and without a `JWT_SECRET`.
 */
export async function hasFormerAccount(
  userId: string,
  secret: string = env.JWT_SECRET,
): Promise<boolean> {
  return (await formerAccountsOf(userId, secret)).length > 0;
}

export interface FormerAccount {
  formerUserId: string;
  /** When the former account was deleted (the tombstone's creation). */
  deletedAt: Date;
  /** Which proven identities the two accounts share. */
  kinds: SafetyIdentityKind[];
}

/**
 * The deleted accounts that shared a proven identity with `userId`, newest
 * deletion first. Feeds `hasFormerAccount` and the admin card's linked
 * accounts (`services/linked-accounts.ts`).
 */
export async function formerAccountsOf(
  userId: string,
  secret: string = env.JWT_SECRET,
): Promise<FormerAccount[]> {
  if (!secret || env.DEMO_MODE_ENABLED) return [];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: IDENTITY_SELECT });
  if (!user) return [];
  const hashes = safetyIdentitiesOf(user, secret).map((identity) => identity.identityHash);
  if (hashes.length === 0) return [];
  const rows = await prisma.safetyTombstone.findMany({
    where: { identityHash: { in: hashes }, formerUserId: { not: userId } },
    select: { formerUserId: true, kind: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const byFormer = new Map<string, FormerAccount>();
  for (const row of rows) {
    const entry = byFormer.get(row.formerUserId) ?? {
      formerUserId: row.formerUserId,
      deletedAt: row.createdAt,
      kinds: [],
    };
    const kind = row.kind as SafetyIdentityKind;
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
    byFormer.set(row.formerUserId, entry);
  }
  return [...byFormer.values()];
}

