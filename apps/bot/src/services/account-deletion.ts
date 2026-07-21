import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import {
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
} from "./cancel-in-flight-matches.js";
import { notifyFounderAccountClosed } from "./founder-notify.js";
import { deleteStorageObject } from "./storage.js";
import { unpinKnownStatusBanner } from "./status-banner.js";

export class AccountDeletionCleanupError extends Error {
  constructor(readonly failedObjects: readonly string[]) {
    super("Account media cleanup failed");
    this.name = "AccountDeletionCleanupError";
  }
}

export interface DeleteUserAccountResult {
  deleted: boolean;
  cancelledMatches: number;
  deletedFounderReports: number;
  deletedStorageObjects: number;
}

/**
 * One owner for destructive account deletion across Telegram and the public
 * mobile API. The sequence is intentionally privacy-first:
 *
 * 1. remove every known user-owned Supabase object, failing closed so a retry
 *    remains possible while the DB references still exist;
 * 2. claim live-match cancellation, remove founder report snapshots, and
 *    delete the User row (all relational data cascades) in one DB transaction;
 * 3. after commit only, deliver partner notifications/compensation and emit
 *    an anonymous lifecycle counter to the founder feed.
 */
export async function deleteUserAccount(
  userId: string,
  api: Api<RawApi> | null,
): Promise<DeleteUserAccountResult> {
  const [user, chatImages] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        telegramId: true,
        statusMessageId: true,
        selfiePath: true,
        verifiedSelfiePath: true,
        profile: {
          select: {
            photos: true,
            profileMedia: true,
            pendingPhotoCandidates: true,
          },
        },
      },
    }),
    prisma.message.findMany({
      where: { userId, imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
  ]);

  if (!user) {
    return {
      deleted: false,
      cancelledMatches: 0,
      deletedFounderReports: 0,
      deletedStorageObjects: 0,
    };
  }

  const selfiePaths = collectOwnedPaths(
    [user.selfiePath, user.verifiedSelfiePath],
    user.id,
  );
  const profilePaths = collectOwnedPaths(
    [
      user.profile?.photos ?? [],
      user.profile?.profileMedia ?? [],
      user.profile?.pendingPhotoCandidates ?? [],
    ],
    user.id,
  );
  const chatPaths = collectOwnedPaths(
    chatImages.map((row) => row.imageUrl),
    user.id,
  );

  const cleanup = await Promise.all([
    removeStorageObjects(env.SUPABASE_SELFIE_BUCKET, selfiePaths),
    removeStorageObjects(env.SUPABASE_PHOTO_BUCKET, profilePaths),
    removeStorageObjects(env.SUPABASE_CHAT_BUCKET, chatPaths),
  ]);
  const failedObjects = cleanup.flatMap((result) => result.failedObjects);
  if (failedObjects.length > 0) {
    throw new AccountDeletionCleanupError(failedObjects);
  }

  // The storage phase has succeeded, so deletion can proceed. Remove the
  // exact known Telegram pin before erasing its durable message id. This is
  // deliberately best-effort: Telegram downtime must not block GDPR erasure,
  // and first-touch cleanup on a future registration is the fallback.
  if (api) {
    await unpinKnownStatusBanner(
      api,
      user.telegramId,
      user.statusMessageId,
    );
  }

  const reports = await prisma.founderReport.findMany({
    select: { id: true, dataJson: true },
  });
  const reportIds = reports
    .filter((report) => containsExactValue(report.dataJson, user.id))
    .map((report) => report.id);

  let cancelled: Awaited<ReturnType<typeof claimInFlightMatchCancellations>> = [];
  const deletedFounderReports = await prisma.$transaction(async (tx) => {
    cancelled = await claimInFlightMatchCancellations(user.id, tx, { strict: true });
    const deletedReports =
      reportIds.length > 0
        ? await tx.founderReport.deleteMany({ where: { id: { in: reportIds } } })
        : { count: 0 };
    await tx.user.delete({ where: { id: user.id } });
    return deletedReports.count;
  });

  // The database state is now irreversible and consistent. Only now may the
  // outside world observe cancellation; a storage-cleanup failure above leaves
  // both the account and every in-flight match untouched for a safe retry.
  await deliverCancelledPartnerEffects(cancelled, api);

  // No user payload is accepted by this notifier: deletion cannot create a
  // fresh external PII copy after the relational data has been erased.
  void notifyFounderAccountClosed("deleted").catch(() => {});

  return {
    deleted: true,
    cancelledMatches: cancelled.length,
    deletedFounderReports,
    deletedStorageObjects:
      selfiePaths.length + profilePaths.length + chatPaths.length,
  };
}

function collectOwnedPaths(values: unknown, userId: string): string[] {
  const paths = new Set<string>();
  const prefix = `${userId}/`;

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith(prefix)) paths.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        visit(item);
      }
    }
  };

  visit(values);
  return [...paths];
}

async function removeStorageObjects(
  bucket: string,
  paths: readonly string[],
): Promise<{ failedObjects: string[] }> {
  const failedObjects: string[] = [];
  for (const path of paths) {
    const deleted = await deleteStorageObject(bucket, path);
    if (!deleted) failedObjects.push(`${bucket}/${path}`);
  }
  return { failedObjects };
}

function containsExactValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsExactValue(item, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsExactValue(item, expected),
    );
  }
  return false;
}
