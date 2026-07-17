import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { deleteStorageObject } from "./storage.js";

/**
 * Verified-selfie retention worker.
 *
 * GDPR Article 9 treats biometric data (face images used for identification)
 * as a special category that must be kept "no longer than necessary". For
 * Gennety the operational need for the stored selfie is:
 *   1. The initial face-match against profile photos (Step 3 pipeline).
 *   2. Re-matching when the user adds a new photo (Step 4 gate).
 *   3. Admin rerun within a reasonable review window.
 *
 * Beyond ~90 days the photo set is stable, the user's appearance has been
 * vetted, and we no longer need a stored selfie. This worker:
 *   • finds users whose `verifiedAt` is older than the cutoff
 *   • deletes the selfie object from Supabase storage
 *   • clears `verifiedSelfiePath` on the row (the field becomes null)
 *
 * `verificationStatus` and `verifiedAt` are intentionally NOT cleared —
 * the user remains verified, just without the stored reference image.
 * If they later upload a new photo, the upload gate re-fetches the reference
 * from Persona for that one comparison via `personaInquiryId`. It fails closed
 * if Persona cannot provide the reference and never persists the fresh copy.
 *
 * Called once daily by the cron in `index.ts`. Idempotent: runs that find
 * nothing to scrub are a cheap COUNT — fine to over-tick.
 */

export const SELFIE_RETENTION_DAYS = 90;
const LOG_PREFIX = "[selfie-retention]";

export interface RetentionResult {
  scanned: number;
  deletedFromStorage: number;
  deletedFromDb: number;
  errors: number;
}

export interface RetentionDeps {
  db: {
    findExpired: (cutoff: Date) => Promise<Array<{ id: string; verifiedSelfiePath: string }>>;
    clearSelfiePath: (userId: string) => Promise<void>;
  };
  deleteStorageObject: typeof deleteStorageObject;
}

/**
 * Scan + scrub. Returns counters so the cron logs a one-line summary on
 * non-zero days (and stays silent on zero-result ticks).
 */
export async function runSelfieRetention(
  deps: RetentionDeps = defaultDeps(),
  retentionDays: number = SELFIE_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const expired = await deps.db.findExpired(cutoff);

  const result: RetentionResult = {
    scanned: expired.length,
    deletedFromStorage: 0,
    deletedFromDb: 0,
    errors: 0,
  };

  for (const row of expired) {
    try {
      const ok = await deps.deleteStorageObject(env.SUPABASE_SELFIE_BUCKET, row.verifiedSelfiePath);
      if (ok) result.deletedFromStorage++;
      // Clear the DB pointer regardless of storage delete outcome — a
      // dangling object is far less bad than a row pointing at a deleted
      // file. If the storage delete fails (already gone, transient), the
      // worker re-tries indirectly: there's nothing left to find unless
      // the path is restored.
      await deps.db.clearSelfiePath(row.id);
      result.deletedFromDb++;
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to scrub`, { userId: row.id, err });
      result.errors++;
    }
  }

  return result;
}

function defaultDeps(): RetentionDeps {
  return {
    db: {
      findExpired: async (cutoff) => {
        const rows = await prisma.user.findMany({
          where: {
            verifiedSelfiePath: { not: null },
            verifiedAt: { not: null, lt: cutoff },
          },
          select: { id: true, verifiedSelfiePath: true },
        });
        // Type narrowing: we filtered on `verifiedSelfiePath: { not: null }`
        // but Prisma's types don't propagate that, so the field is still
        // `string | null`. Filter again to satisfy the consumer signature.
        return rows.flatMap((r) =>
          r.verifiedSelfiePath ? [{ id: r.id, verifiedSelfiePath: r.verifiedSelfiePath }] : [],
        );
      },
      clearSelfiePath: async (userId) => {
        await prisma.user.update({
          where: { id: userId },
          data: { verifiedSelfiePath: null },
        });
      },
    },
    deleteStorageObject,
  };
}
