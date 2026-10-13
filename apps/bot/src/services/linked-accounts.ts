import { prisma } from "@gennety/db";
import { LINKED_ACCOUNT_GROUPS_MAX, LINKED_ACCOUNTS_MAX } from "@gennety/shared";
import { formerAccountsOf } from "./former-account.js";
import type { SafetyIdentityKind } from "./identity-hash.js";

/**
 * Accounts that look like the same person, for the admin dashboard only
 * (decision 2026-10-13). A second account is allowed — nothing in the product
 * reads this, nobody is blocked or flagged by it. It exists so the operator can
 * see that two accounts belong together and compare them.
 *
 * Two signals, both from data already stored for another purpose, so nothing
 * new is collected and no external service is asked:
 *
 *  - **`same_photo`** — the two live profiles share a profile photo: one of the
 *    perceptual hashes the upload validator keeps (`Profile.uploadedPhotoHashes`)
 *    is on both. Exact hash equality, so it catches the same picture uploaded
 *    twice, not a different photo of the same face.
 *  - **`former_account`** — the account's proven Telegram id, phone or email
 *    belonged to an account that was deleted (its tombstone,
 *    `services/former-account.ts`): the same person registering again.
 *
 * Computed on read rather than stored, so it is never stale and needs no
 * column: one profile's hashes against everyone else's for the card, one
 * grouping query for the list.
 */

export type AccountLinkSignal = "same_photo" | "former_account";

export interface LinkedAccount {
  userId: string;
  /** Null for a deleted account — its row, name included, is gone. */
  firstName: string | null;
  deleted: boolean;
  /** Live accounts: when it was created. Deleted ones: when it was deleted. */
  at: Date;
  signals: AccountLinkSignal[];
  /** How many profile photos the two accounts share (`same_photo`). */
  sharedPhotos: number;
  /** Which proven identities the two accounts share (`former_account`). */
  sharedIdentities: SafetyIdentityKind[];
}

/** Every account linked to `userId`, strongest evidence first. */
export async function linkedAccountsOf(userId: string): Promise<LinkedAccount[]> {
  const [profile, former] = await Promise.all([
    prisma.profile.findUnique({ where: { userId }, select: { uploadedPhotoHashes: true } }),
    formerAccountsOf(userId),
  ]);

  const linked: LinkedAccount[] = [];
  const hashes = profile?.uploadedPhotoHashes ?? [];
  if (hashes.length > 0) {
    const mine = new Set(hashes);
    const others = await prisma.profile.findMany({
      where: { userId: { not: userId }, uploadedPhotoHashes: { hasSome: hashes } },
      select: {
        userId: true,
        uploadedPhotoHashes: true,
        user: { select: { firstName: true, createdAt: true } },
      },
      take: LINKED_ACCOUNTS_MAX,
    });
    for (const other of others) {
      linked.push({
        userId: other.userId,
        firstName: other.user.firstName,
        deleted: false,
        at: other.user.createdAt,
        signals: ["same_photo"],
        sharedPhotos: new Set(other.uploadedPhotoHashes.filter((hash) => mine.has(hash))).size,
        sharedIdentities: [],
      });
    }
  }
  for (const account of former) {
    linked.push({
      userId: account.formerUserId,
      firstName: null,
      deleted: true,
      at: account.deletedAt,
      signals: ["former_account"],
      sharedPhotos: 0,
      sharedIdentities: account.kinds,
    });
  }
  return linked
    .sort((a, b) => b.sharedPhotos + b.sharedIdentities.length - (a.sharedPhotos + a.sharedIdentities.length))
    .slice(0, LINKED_ACCOUNTS_MAX);
}

export interface LinkedAccountGroupMember {
  userId: string;
  firstName: string | null;
  deleted: boolean;
  createdAt: Date | null;
}

export interface LinkedAccountGroup {
  /** Stable id: the smallest member id. */
  id: string;
  signals: AccountLinkSignal[];
  members: LinkedAccountGroupMember[];
}

interface Edge {
  a: string;
  b: string;
  signal: AccountLinkSignal;
}

/**
 * Every group of accounts that look like one person, largest first. Edges are
 * shared photos between live profiles and "re-registered after deleting" links
 * (a tombstone applied to a new account, `restoredToUserId`); groups are their
 * connected components, so three accounts sharing photos pairwise are one group.
 */
export async function linkedAccountGroups(): Promise<LinkedAccountGroup[]> {
  const [photoGroups, restored] = await Promise.all([
    prisma.$queryRaw<Array<{ user_ids: string[] }>>`
      SELECT array_agg(DISTINCT p.user_id::text) AS user_ids
        FROM profiles p
        CROSS JOIN LATERAL unnest(p.uploaded_photo_hashes) AS h(hash)
       GROUP BY h.hash
      HAVING count(DISTINCT p.user_id) > 1
    `,
    prisma.safetyTombstone.findMany({
      where: { restoredToUserId: { not: null } },
      distinct: ["formerUserId"],
      select: { formerUserId: true, restoredToUserId: true },
    }),
  ]);

  const edges: Edge[] = [];
  for (const row of photoGroups) {
    const [first, ...rest] = row.user_ids;
    for (const other of rest) edges.push({ a: first!, b: other, signal: "same_photo" });
  }
  for (const row of restored) {
    if (row.restoredToUserId) {
      edges.push({ a: row.formerUserId, b: row.restoredToUserId, signal: "former_account" });
    }
  }
  if (edges.length === 0) return [];

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) {
    if (!parent.has(edge.a)) parent.set(edge.a, edge.a);
    if (!parent.has(edge.b)) parent.set(edge.b, edge.b);
    const ra = find(edge.a);
    const rb = find(edge.b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }

  const groups = new Map<string, { ids: Set<string>; signals: Set<AccountLinkSignal> }>();
  for (const edge of edges) {
    const root = find(edge.a);
    const group = groups.get(root) ?? { ids: new Set<string>(), signals: new Set<AccountLinkSignal>() };
    group.ids.add(edge.a);
    group.ids.add(edge.b);
    group.signals.add(edge.signal);
    groups.set(root, group);
  }

  const kept = [...groups.values()]
    .sort((x, y) => y.ids.size - x.ids.size)
    .slice(0, LINKED_ACCOUNT_GROUPS_MAX);
  const allIds = [...new Set(kept.flatMap((group) => [...group.ids]))];
  const users = await prisma.user.findMany({
    where: { id: { in: allIds } },
    select: { id: true, firstName: true, createdAt: true },
  });
  const byId = new Map(users.map((user) => [user.id, user]));

  return kept.map((group) => {
    const ids = [...group.ids].sort();
    return {
      id: ids[0]!,
      signals: [...group.signals].sort(),
      members: ids.map((id) => {
        const user = byId.get(id);
        return {
          userId: id,
          firstName: user?.firstName ?? null,
          deleted: !user,
          createdAt: user?.createdAt ?? null,
        };
      }),
    };
  });
}
