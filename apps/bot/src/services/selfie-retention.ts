import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { deleteStorageObject, storageKeyWrittenAt } from "./storage.js";

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
 *   • finds every stored selfie older than the cutoff — by the SELFIE's own
 *     age (`selfieStoredAt`), whatever the verification outcome
 *   • deletes the selfie object from Supabase storage
 *   • clears `verifiedSelfiePath` on the row (the field becomes null)
 *
 * It used to select `verifiedAt < cutoff`, so a selfie stored by a run that
 * ended retryable, in manual review or rejected — `verifiedAt` null — was never
 * scrubbed at all, and a re-verification restarted the clock of an older one
 * (A13-M12). Biometric data of the people who did NOT pass was the data kept
 * longest.
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
    /** Clears the pointer only while it still names `path`. */
    clearSelfiePath: (userId: string, path: string) => Promise<void>;
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
      await deps.db.clearSelfiePath(row.id, row.verifiedSelfiePath);
      result.deletedFromDb++;
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to scrub`, { userId: row.id, err });
      result.errors++;
    }
  }

  return result;
}

/**
 * When a stored selfie was written. Every key `uploadSelfie` mints is
 * `{userId}/{Date.now()}.{ext}`, so the key itself carries its upload time —
 * the one timestamp that belongs to the selfie rather than to the account (a
 * later photo edit moves `faceMatchedAt`; a later passing run moves
 * `verifiedAt`). `fallback` answers for a key without that shape; `null` when
 * neither says anything.
 */
export function selfieStoredAt(path: string, fallback: Date | null): Date | null {
  return storageKeyWrittenAt(path) ?? fallback;
}

function defaultDeps(): RetentionDeps {
  return {
    db: {
      findExpired: async (cutoff) => {
        // Every stored selfie, whatever the verification outcome; the age test
        // is on the key, which SQL cannot read without parsing it, and the set
        // is bounded by the number of people who ever ran liveness.
        const rows = await prisma.user.findMany({
          where: { verifiedSelfiePath: { not: null } },
          select: { id: true, verifiedSelfiePath: true, verifiedAt: true, faceMatchedAt: true },
        });
        let undatable = 0;
        const expired = rows.flatMap((r) => {
          if (!r.verifiedSelfiePath) return [];
          // `verifiedAt` before `faceMatchedAt` for an old-format key: both
          // are at or after the upload, and the earlier one is the closer.
          const storedAt = selfieStoredAt(r.verifiedSelfiePath, r.verifiedAt ?? r.faceMatchedAt);
          if (!storedAt) {
            undatable += 1;
            return [];
          }
          return storedAt < cutoff ? [{ id: r.id, verifiedSelfiePath: r.verifiedSelfiePath }] : [];
        });
        if (undatable > 0) {
          console.warn(`${LOG_PREFIX} ${undatable} stored selfie(s) carry no datable key or timestamp`);
        }
        return expired;
      },
      clearSelfiePath: async (userId, path) => {
        // Conditional: a liveness run that stored a NEW selfie between the scan
        // and this write must keep its reference.
        await prisma.user.updateMany({
          where: { id: userId, verifiedSelfiePath: path },
          data: { verifiedSelfiePath: null },
        });
      },
    },
    deleteStorageObject,
  };
}
