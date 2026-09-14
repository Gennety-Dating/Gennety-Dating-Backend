import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import {
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
} from "./cancel-in-flight-matches.js";
import {
  FOUNDER_ACCOUNT_CLOSED_SELECT,
  notifyFounderAccountClosed,
  notifyFounderDeletionStuckRefunds,
} from "./founder-notify.js";
import { getMainBotApi } from "./main-bot-api.js";
import { findRefundsInFlight, type RefundInFlightRow } from "./refund-in-flight.js";
import { writeSafetyTombstones } from "./safety-tombstone.js";
import {
  deleteStorageObject,
  downloadProfileImage,
  listStorageObjects,
  storageBucketState,
} from "./storage.js";
import { unpinKnownStatusBanner } from "./status-banner.js";

/** Cap mirrored from `founder-notify.ts`'s Telegram media-group ceiling. */
const FOUNDER_MEDIA_GROUP_MAX = 10;

export class AccountDeletionCleanupError extends Error {
  constructor(readonly failedObjects: readonly string[]) {
    super("Account media cleanup failed");
    this.name = "AccountDeletionCleanupError";
  }
}

/**
 * Deletion refused for now — nothing was erased and a retry later succeeds
 * (A13-H14). The one reason today is a refund a sweep still owns: payment rows
 * outlive the account, but the Telegram id a Stars refund is sent to does not,
 * so deleting now would strand the money. Callers answer "try again later"
 * (`DELETE /v1/me` → 409 `refund-in-progress`, the Telegram settings flow → a
 * localized message); it is never reported as a failure of the erasure itself.
 */
export class AccountDeletionDeferredError extends Error {
  constructor(
    readonly reason: "refund_in_progress",
    readonly rows: readonly RefundInFlightRow[],
  ) {
    super(`Account deletion deferred: ${reason}`);
    this.name = "AccountDeletionDeferredError";
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
 * mobile API. The sequence is intentionally ordered so nothing is lost before
 * it is captured, and nothing external happens before the DB state is final:
 *
 * 0. refuse while a refund a sweep owns is still young
 *    (`AccountDeletionDeferredError`) — before anything is erased, so the
 *    refusal costs the person nothing but a retry (A13-H14);
 * 1. snapshot the founder-DM profile fields and download any profile-photo
 *    bytes, since both the row and any Supabase-hosted photos are about to
 *    be erased;
 * 2. remove EVERY object under `${userId}/` in each user bucket — listed from
 *    the bucket, not only the paths a row still references (A13-M12) — failing
 *    closed so a retry remains possible while the DB references still exist;
 * 3. in one DB transaction: claim live-match cancellation, re-check refunds,
 *    write the safety tombstones and stamp the reports/blocks filed against the
 *    account (`writeSafetyTombstones`), remove founder report snapshots, and
 *    delete the User row. Payment ledgers, purchases, and reports keep their
 *    rows with a null owner (`onDelete: SetNull`); everything else cascades;
 * 4. after commit only, deliver partner notifications/compensation and DM the
 *    founder feed the full profile + phone + photos of the departing user — an
 *    internal ops channel to one trusted operator, restored by an explicit
 *    founder decision on 2026-08-02 (see `services/founder-notify.ts` for the
 *    tradeoff it commits us to, and `legal/privacy-policy.md` §12.2, which
 *    discloses it). Refunds older than the defer window that the account still
 *    had are reported to the founder with their ids — nothing can settle them
 *    automatically once the owner is gone.
 */
export async function deleteUserAccount(
  userId: string,
  api: Api<RawApi> | null,
): Promise<DeleteUserAccountResult> {
  const [user, chatImages] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...FOUNDER_ACCOUNT_CLOSED_SELECT,
        id: true,
        telegramId: true,
        statusMessageId: true,
        selfiePath: true,
        verifiedSelfiePath: true,
        profile: {
          select: {
            ...FOUNDER_ACCOUNT_CLOSED_SELECT.profile.select,
            photos: true,
            profileMedia: true,
            pendingPhotoCandidates: true,
          },
        },
        // A voice prompt uploaded by a native client leaves BYTES in our own
        // bucket — unlike a Telegram-recorded one, which is only a file_id.
        // Missing this select is silent: the row cascades away and the audio
        // stays, so an erasure request is not honoured and nothing says so.
        voicePrompt: { select: { storagePath: true } },
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

  // Before anything is erased: a refusal here must cost nothing but a retry.
  const refunds = await findRefundsInFlight(user.id);
  if (refunds.blocking.length > 0) {
    throw new AccountDeletionDeferredError("refund_in_progress", refunds.blocking);
  }

  // Snapshot the founder-DM photo bytes BEFORE storage cleanup below removes
  // the Supabase objects. Telegram file_ids stay resolvable after the row and
  // its storage objects are gone, but a Supabase path does not — so the only
  // safe moment to read either kind is right now, before anything is erased.
  const founderPhotoBuffers = env.FOUNDER_NOTIFY_ENABLED
    ? await downloadFounderPhotoBuffers(user.profile?.photos ?? [])
    : [];

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
  const voicePaths = collectOwnedPaths(
    [user.voicePrompt?.storagePath ?? null],
    user.id,
  );

  const cleanup = await Promise.all([
    removeUserStorage(env.SUPABASE_SELFIE_BUCKET, user.id, selfiePaths),
    removeUserStorage(env.SUPABASE_PHOTO_BUCKET, user.id, profilePaths),
    removeUserStorage(env.SUPABASE_CHAT_BUCKET, user.id, chatPaths),
    removeUserStorage(env.SUPABASE_VOICE_BUCKET, user.id, voicePaths),
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
  let staleRefunds: RefundInFlightRow[] = refunds.stale;
  const deletedFounderReports = await prisma.$transaction(async (tx) => {
    cancelled = await claimInFlightMatchCancellations(user.id, tx, { strict: true });
    // Re-checked where it commits: a payment or a failed refund that landed
    // after the check above would otherwise lose its owner with this row.
    // Rolling back here undoes the cancellation too. (Storage is already gone
    // by now; for a charge in that window, that is the cheaper loss.)
    const refundsNow = await findRefundsInFlight(user.id, tx);
    if (refundsNow.blocking.length > 0) {
      throw new AccountDeletionDeferredError("refund_in_progress", refundsNow.blocking);
    }
    staleRefunds = refundsNow.stale;
    // Moderation status, strikes, and the reports/blocks filed AGAINST this
    // account survive as keyed hashes, relinked if the same person returns —
    // before the row goes, so the stamps and the deletion commit together.
    await writeSafetyTombstones(tx, user.id);
    const deletedReports =
      reportIds.length > 0
        ? await tx.founderReport.deleteMany({ where: { id: { in: reportIds } } })
        : { count: 0 };
    await tx.user.delete({ where: { id: user.id } });
    // `bot_sessions` is keyed by Telegram CHAT id and carries no relation to
    // `users`, so the cascade above cannot reach it — it is the one store that
    // survives an account. Two reasons that is wrong, and the second is the one
    // that actually broke a flow:
    //
    // 1. GDPR. The row holds `pendingPhotos` (Telegram file_ids of the erased
    //    profile), `contextDumpBuffer` (a pasted AI-memory export) and
    //    `activeMatchId`. A hard delete that leaves them behind is not erasure.
    // 2. The next account in the same chat INHERITS that state. A session left
    //    with `expectingPhoto: true` put a fresh account into the photo stage
    //    while the collector was still several questions from it, so uploading
    //    three photos produced a Continue button that finalized onboarding
    //    early — and the finalize guard then refused, permanently.
    //
    // Telegram callers must ALSO reset `ctx.session`: grammY writes the live
    // session back after the handler returns and would resurrect the row.
    await tx.botSession.deleteMany({
      where: { key: String(user.telegramId) },
    });
    return deletedReports.count;
  });

  // The database state is now irreversible and consistent. Only now may the
  // outside world observe cancellation; a storage-cleanup failure above leaves
  // both the account and every in-flight match untouched for a safe retry.
  await deliverCancelledPartnerEffects(cancelled, api);

  if (staleRefunds.length > 0) {
    await notifyFounderDeletionStuckRefunds({
      userId: user.id,
      telegramId: user.telegramId,
      rows: staleRefunds.map((row) => ({
        table: row.table,
        id: row.id,
        status: row.status,
        createdAt: row.since,
      })),
    });
  }

  // Full profile + phone + photos, using the snapshot and photo bytes
  // captured before the row/storage objects were erased above.
  void notifyFounderAccountClosed("deleted", user, founderPhotoBuffers).catch(
    () => {},
  );

  return {
    deleted: true,
    cancelledMatches: cancelled.length,
    deletedFounderReports,
    deletedStorageObjects: cleanup.reduce((sum, result) => sum + result.deleted, 0),
  };
}

async function downloadFounderPhotoBuffers(
  photoRefs: readonly string[],
): Promise<Buffer[]> {
  const botApi = getMainBotApi();
  if (!botApi) return [];
  const buffers: Buffer[] = [];
  for (const ref of photoRefs.slice(0, FOUNDER_MEDIA_GROUP_MAX)) {
    const buf = await downloadProfileImage(ref, botApi);
    if (buf) buffers.push(buf);
  }
  return buffers;
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

/**
 * Erase everything this account owns in one bucket: every key under
 * `${userId}/` that the bucket lists, plus the referenced paths (already
 * `${userId}/`-scoped by `collectOwnedPaths`) in case the listing and a
 * concurrent upload cross.
 *
 * The listing is what A13-M12 is about. Referenced paths alone missed every
 * object no row points at any more — a liveness selfie replaced by a later run,
 * a re-recorded voice prompt, a chat image uploaded and never sent — and those
 * are exactly the biometric and voice data an erasure request is for.
 *
 * Fails closed like the per-object deletes: a listing that cannot be completed
 * is a failure, never "nothing there". The one exception is storage that is
 * not configured at all AND a row that references nothing in this bucket —
 * nothing can have been uploaded, and refusing would make every local account
 * undeletable.
 */
async function removeUserStorage(
  bucket: string,
  userId: string,
  referencedPaths: readonly string[],
): Promise<{ failedObjects: string[]; deleted: number }> {
  const storageConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  if (!storageConfigured && referencedPaths.length === 0) {
    return { failedObjects: [], deleted: 0 };
  }

  const listed = await listStorageObjects(bucket, userId);
  if (listed === null) {
    // A bucket Supabase says does not exist holds nothing to erase — unless a
    // row still names an object in it, which is then a misconfiguration worth
    // failing on. Without this, one never-created bucket (voice, on an install
    // where the feature was never on) made every account undeletable.
    if (referencedPaths.length === 0 && (await storageBucketState(bucket)) === "missing") {
      return { failedObjects: [], deleted: 0 };
    }
    return { failedObjects: [`${bucket}/${userId}/ (listing failed)`], deleted: 0 };
  }

  const failedObjects: string[] = [];
  let deleted = 0;
  for (const path of new Set([...listed, ...referencedPaths])) {
    if (await deleteStorageObject(bucket, path)) deleted += 1;
    else failedObjects.push(`${bucket}/${path}`);
  }
  return { failedObjects, deleted };
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
