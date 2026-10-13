import { prisma } from "@gennety/db";
import type { StorageAdapter } from "grammy";
import { BOT_SESSION_SNAPSHOT_MAX_KEYS } from "@gennety/shared";

/**
 * grammY StorageAdapter backed by the `bot_sessions` table in PostgreSQL.
 * Sessions survive bot restarts — no more in-memory-only state.
 *
 * **A write-back that would store what is already stored is skipped.** grammY
 * writes the session back whenever an update read it, and the middleware in
 * `bot.ts` reads it on every update — so every update cost a full-JSON UPSERT
 * on top of its SELECT, most of them rewriting the same row. `read` remembers
 * the row's JSON in canonical form (object keys sorted, normalised exactly the
 * way the Json column serialises a value), and `write` compares the session it
 * is handed against that snapshot. The UPSERT is skipped only when all of
 * these hold:
 *
 *   - this update read the row (the snapshot is taken by `read` and consumed
 *     by the first `write` or `delete` for the key after it, so it is never
 *     older than the update's own read);
 *   - the value is the same JSON as the row, so the UPSERT would leave `data`
 *     as it is;
 *   - a user row still owns the key. The UPSERT also bumps `updated_at`, and
 *     the one reader of that column is the retention sweep for orphaned
 *     sessions — rows with NO user. A row without one is therefore always
 *     written, and checking at write time (not read time) also covers an
 *     account deleted by the update itself (`deleteUserAccount` removes the
 *     user and the session row together).
 *
 * Writers that bypass this adapter are covered too:
 *
 *   - the debounced flushes and the Mini App's onboarding patch run on the
 *     chat's queue (`dispatchToChat`), which never overlaps an update of the
 *     same chat, and call `forgetSessionSnapshot` after writing, so even a
 *     future caller inside an update gets its write-back back;
 *   - account deletion removes the row together with its user, which the user
 *     check above sees;
 *   - anything outside every queue (a migration, a script) that lands between
 *     an update's read and its skipped write-back keeps its own value — the
 *     outcome it would have had landing just after that write-back.
 */

/** Canonical stored JSON per key, as last read. Insertion order = age. */
const snapshots = new Map<string, string>();

function rememberSnapshot(key: string, canonical: string): void {
  snapshots.delete(key);
  snapshots.set(key, canonical);
  if (snapshots.size > BOT_SESSION_SNAPSHOT_MAX_KEYS) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

function takeSnapshot(key: string): string | undefined {
  const canonical = snapshots.get(key);
  snapshots.delete(key);
  return canonical;
}

/**
 * Drop what the adapter remembers about a session row. For code that writes
 * `bot_sessions` directly instead of through grammY.
 */
export function forgetSessionSnapshot(key: string): void {
  snapshots.delete(key);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((field) => `${JSON.stringify(field)}:${stableStringify(record[field])}`);
  return `{${fields.join(",")}}`;
}

/**
 * The JSON value a Json column ends up holding for `value`, with object keys
 * sorted — two values compare equal exactly when storing either leaves the
 * same `jsonb`. The round trip through `JSON.stringify` applies the same
 * normalisation the column write does (`toJSON`, dropped `undefined`, `NaN` as
 * `null`). `null` when the value cannot be serialised at all; the write that
 * follows then runs, and fails, exactly as before.
 */
export function canonicalSessionJson(value: unknown): string | null {
  try {
    const serialised = JSON.stringify(value);
    if (serialised === undefined) return null;
    return stableStringify(JSON.parse(serialised) as unknown);
  } catch {
    return null;
  }
}

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/**
 * The `users.telegram_id` a session key can belong to: the key must be exactly
 * how Postgres prints that bigint (`telegram_id::text = key` is the coupling
 * the retention sweep uses). `null` for any key no user can own.
 */
export function telegramIdOfSessionKey(key: string): bigint | null {
  if (!/^(0|-?[1-9][0-9]{0,18})$/.test(key)) return null;
  const id = BigInt(key);
  return id >= INT8_MIN && id <= INT8_MAX ? id : null;
}

async function sessionKeyHasUser(key: string): Promise<boolean> {
  const telegramId = telegramIdOfSessionKey(key);
  if (telegramId === null) return false;
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { id: true },
    });
    return user !== null;
  } catch {
    // Unknown is treated as "no": the write-back then runs as it always did.
    return false;
  }
}

export function prismaSessionAdapter<T extends object>(
  defaults?: T,
): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const row = await prisma.botSession.findUnique({ where: { key } });
      if (!row) {
        snapshots.delete(key);
        return undefined;
      }
      const canonical = canonicalSessionJson(row.data);
      if (canonical === null) snapshots.delete(key);
      else rememberSnapshot(key, canonical);
      const stored = row.data as T;
      return defaults ? { ...defaults, ...stored } : stored;
    },

    async write(key: string, value: T): Promise<void> {
      const stored = takeSnapshot(key);
      if (
        stored !== undefined &&
        canonicalSessionJson(value) === stored &&
        (await sessionKeyHasUser(key))
      ) {
        return;
      }
      await prisma.botSession.upsert({
        where: { key },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: { key, data: value as any },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: { data: value as any },
      });
    },

    async delete(key: string): Promise<void> {
      snapshots.delete(key);
      await prisma.botSession.deleteMany({ where: { key } });
    },
  };
}
