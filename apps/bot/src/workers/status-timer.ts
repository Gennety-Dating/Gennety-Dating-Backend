import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { prisma } from "@gennety/db";
import {
  formatStatusText,
  nextMatchDispatchAt,
  isMatchBatchProcessing,
} from "@gennety/shared";
import type { Language } from "@gennety/shared";

/**
 * Live discrete-timer worker for the pinned status banner.
 *
 * Runs every minute (see `STATUS_TIMER_CRON_SCHEDULE` in index.ts). For
 * each active user with a `statusMessageId`:
 *   1. Compute the current banner text for their language.
 *   2. Skip the edit if the text is unchanged since the last tick
 *      (in-memory cache keyed by telegramId).
 *   3. Otherwise `editMessageText`, rate-limited to
 *      `MAX_EDITS_PER_SECOND` across the whole batch.
 *
 * On a 400 / 403 error that indicates the banner is gone (user unpinned,
 * blocked the bot, deleted the chat, or cleared the message), we null
 * out `statusMessageId` so we stop retrying.
 *
 * The render cache survives restarts only in memory; after a process
 * restart the first tick will hit "message is not modified" for every
 * user whose text hasn't changed — we treat that as a cache-warming
 * signal and populate the cache, so subsequent ticks are no-ops.
 */

/** Telegram allows ~30 bot messages/sec globally — stay well under. */
const MAX_EDITS_PER_SECOND = 25;

export interface StatusTimerOptions {
  now?: Date;
  /** In-memory cache of last-rendered text, keyed by telegramId. */
  renderCache?: Map<string, string>;
  /** Sleep function for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface StatusTimerResult {
  scanned: number;
  edited: number;
  skippedSameText: number;
  cleared: number;
  errors: number;
}

const defaultCache = new Map<string, string>();
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function statusTimerTick(
  api: Api<RawApi>,
  options: StatusTimerOptions = {},
): Promise<StatusTimerResult> {
  const now = options.now ?? new Date();
  const cache = options.renderCache ?? defaultCache;
  const sleep = options.sleep ?? defaultSleep;

  const nextMatchAt = nextMatchDispatchAt(now);
  const isProcessing = isMatchBatchProcessing(now);

  const users = await prisma.user.findMany({
    where: {
      status: "active",
      statusMessageId: { not: null },
      // M-17: mobile-only synthetic users (negative telegramId) shouldn't
      // even be scanned — they don't have a Telegram banner to edit.
      telegramId: { gt: 0n },
    },
    select: {
      telegramId: true,
      language: true,
      statusMessageId: true,
    },
  });

  const result: StatusTimerResult = {
    scanned: users.length,
    edited: 0,
    skippedSameText: 0,
    cleared: 0,
    errors: 0,
  };

  let editsThisSecond = 0;
  let windowStart = Date.now();

  for (const user of users) {
    const lang: Language = user.language ?? "en";
    const text = formatStatusText({ now, nextMatchAt, isProcessing }, lang);

    const cacheKey = String(user.telegramId);
    if (cache.get(cacheKey) === text) {
      result.skippedSameText++;
      continue;
    }

    // Rate-limit to MAX_EDITS_PER_SECOND.
    if (editsThisSecond >= MAX_EDITS_PER_SECOND) {
      const elapsed = Date.now() - windowStart;
      if (elapsed < 1000) await sleep(1000 - elapsed);
      editsThisSecond = 0;
      windowStart = Date.now();
    }

    try {
      await api.editMessageText(
        Number(user.telegramId),
        user.statusMessageId!,
        text,
      );
      cache.set(cacheKey, text);
      result.edited++;
      editsThisSecond++;
    } catch (err) {
      // "Not modified" is benign — the banner already shows `text`, so
      // populate the cache to suppress the same wasted edit next tick.
      if (
        err instanceof GrammyError &&
        err.description.toLowerCase().includes("message is not modified")
      ) {
        cache.set(cacheKey, text);
        result.skippedSameText++;
        continue;
      }

      const handled = await handleEditError(err, user.telegramId, cache, cacheKey);
      if (handled === "cleared") result.cleared++;
      else result.errors++;
    }
  }

  return result;
}

type EditErrorOutcome = "cleared" | "retry-skipped" | "unknown";

/**
 * Classify a Telegram error from `editMessageText`. Three outcomes:
 *  - "cleared": banner is irrecoverable (unpinned / blocked / chat gone) →
 *    wipe `statusMessageId` so we stop trying.
 *  - "retry-skipped": transient (429 too many requests, 5xx) → leave row
 *    alone; next tick will try again.
 *  - "unknown": unexpected; log and leave alone.
 *
 * The "message is not modified" case is handled inline by the caller,
 * which has access to `text` for the cache seed.
 */
async function handleEditError(
  err: unknown,
  telegramId: bigint,
  cache: Map<string, string>,
  cacheKey: string,
): Promise<EditErrorOutcome> {
  if (err instanceof GrammyError) {
    const desc = err.description.toLowerCase();

    // Banner gone / user unreachable — clear the row.
    const unrecoverable =
      err.error_code === 403 || // blocked, kicked, chat deleted
      desc.includes("message to edit not found") ||
      desc.includes("message can't be edited") ||
      desc.includes("chat not found") ||
      desc.includes("message_id_invalid");

    if (unrecoverable) {
      await prisma.user.update({
        where: { telegramId },
        data: { statusMessageId: null },
      });
      cache.delete(cacheKey);
      return "cleared";
    }

    // 429 or 5xx — next tick retries.
    if (err.error_code === 429 || err.error_code >= 500) {
      console.warn(
        `[status-timer] transient ${err.error_code} for ${telegramId}: ${err.description}`,
      );
      return "retry-skipped";
    }
  }

  console.warn(
    `[status-timer] unexpected edit failure for ${telegramId}:`,
    (err as Error).message,
  );
  return "unknown";
}
