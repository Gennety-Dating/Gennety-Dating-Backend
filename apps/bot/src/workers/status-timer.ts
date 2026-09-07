import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { prisma } from "@gennety/db";
import { dropOutpacesNotices, type Language } from "@gennety/shared";
import {
  buildStatusBannerKeyboard,
  buildStatusBannerView,
  classifyStatusBannerError,
  createStatusBanner,
  statusBannerRenderCache,
  type StatusBannerFailureKind,
} from "../services/status-banner.js";
import type { StatusBannerStage } from "../services/status-banner-view.js";
import { loadBannerStages } from "../services/status-banner-stage.js";
import { filterRematchEligible } from "../services/rematch.js";
import { isMarketPending } from "../handlers/menu/city-switch.js";
import { BoundedMap } from "../utils/bounded-map.js";

const MAX_EDITS_PER_SECOND = 25;
/**
 * Active accounts one tick will look at.
 *
 * The tick used to read EVERY active account, every minute, with a profile
 * join, no `take`, and a `WHERE` no index covered. The failure it invites is
 * not "the banner is a little late": `createStatusTimerRunner` guards against
 * overlap, so a tick that overruns its minute makes the next ones no-ops, and
 * the countdown then freezes for the whole base at once.
 *
 * The bound is also honest about what a tick can physically do. At
 * `MAX_EDITS_PER_SECOND` a 60-second tick can perform about 1500 edits, so
 * reading tens of thousands of rows to act on at most fifteen hundred of them
 * is work thrown away. A cursor walks the base in rotation instead: every
 * account is still reached, just over several minutes rather than in one, and
 * the banner's content is a countdown that moves in minutes anyway.
 */
const ACTIVE_USERS_PER_TICK = 1_500;
/**
 * Accounts whose pointer needs clearing per tick — they left `active` while a
 * pinned banner was still up. This set is naturally tiny (it drains as it is
 * processed and nothing refills it in bulk), so it is read whole rather than
 * paged, and merely capped so a mass suspension cannot swamp a tick.
 */
const STALE_POINTERS_PER_TICK = 500;
const PIN_AUDIT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRANSIENT_BACKOFF_MS = 15 * 60 * 1000;
const UNREACHABLE_BACKOFF_MS = 6 * 60 * 60 * 1000;

interface RetryEntry {
  failures: number;
  retryAt: number;
}

/**
 * Where the rotation stopped last tick — the id of the last active account
 * looked at, or `null` to start from the beginning.
 *
 * Deliberately in memory rather than in the database: it is a fairness hint,
 * not state anyone depends on. A restart resuming from the top costs one extra
 * pass over accounts that were about to be refreshed anyway.
 */
const defaultCursor = { lastUserId: null as string | null };

export interface StatusTimerOptions {
  now?: Date;
  renderCache?: Map<string, string>;
  retryState?: Map<string, RetryEntry>;
  pinAuditAt?: Map<string, number>;
  forcePinAudit?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the rotation cursor, so a test can pin or observe it. */
  cursor?: { lastUserId: string | null };
  /** Test seam: how many active accounts this tick may take. */
  activeUsersPerTick?: number;
}

export interface StatusTimerResult {
  eligible: number;
  tracked: number;
  created: number;
  edited: number;
  repinned: number;
  removedInactive: number;
  unchanged: number;
  transientFailures: number;
  permanentFailures: number;
}

/**
 * Per-chat bookkeeping for the tick. Bounded for the same reason as the render
 * cache next door: the key space is every account this worker has ever served,
 * the process lives for weeks, and an entry is only removed for someone the
 * tick actually revisits. Losing either entry is harmless — a dropped
 * `retryState` restarts the backoff, a dropped `pinAuditAt` buys one extra pin
 * audit — so eviction can never cost more than one API call.
 */
const TICK_STATE_MAX = 10_000;
const defaultRetryState = new BoundedMap<string, RetryEntry>(TICK_STATE_MAX);
const defaultPinAuditAt = new BoundedMap<string, number>(TICK_STATE_MAX);
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function statusTimerTick(
  api: Api<RawApi>,
  options: StatusTimerOptions = {},
): Promise<StatusTimerResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const cache = options.renderCache ?? statusBannerRenderCache;
  const retryState = options.retryState ?? defaultRetryState;
  const pinAuditAt = options.pinAuditAt ?? defaultPinAuditAt;
  const sleep = options.sleep ?? defaultSleep;
  const cursor = options.cursor ?? defaultCursor;
  const activeLimit = options.activeUsersPerTick ?? ACTIVE_USERS_PER_TICK;

  const select = {
    id: true,
    telegramId: true,
    language: true,
    status: true,
    statusMessageId: true,
    // §1.1 — an account registered in a city we haven't launched gets a
    // waitlist banner instead of a countdown to a drop it can't be in.
    profile: { select: { homeCityKey: true, homeCity: true } },
  } as const;
  // Reachable over Telegram at all: a mobile-only account carries a synthetic
  // negative id and has no chat to pin anything in.
  const reachable = {
    telegramId: { gt: 0n },
    platform: { in: ["telegram" as const, "both" as const] },
  };

  // Two queries where there used to be one `OR`. The `OR` spanned `status` and
  // `statusMessageId`, so no index could serve it and the whole users table was
  // scanned once a minute; split, the active side is an index range over
  // `[status, id]` and can be paged by cursor.
  const activeUsers = await prisma.user.findMany({
    where: {
      ...reachable,
      status: "active",
      ...(cursor.lastUserId ? { id: { gt: cursor.lastUserId } } : {}),
    },
    orderBy: { id: "asc" },
    take: activeLimit,
    select,
  });

  // A page that came back short means the rotation reached the end of the base;
  // the next tick starts from the top. Otherwise it resumes after the last row
  // seen, so nobody is refreshed twice while somebody else waits.
  const lastSeen = activeUsers.at(-1);
  cursor.lastUserId = activeUsers.length < activeLimit ? null : (lastSeen?.id ?? null);

  // Accounts that left `active` with a banner still pinned. Not part of the
  // rotation: the set drains as it is processed, so leaving it behind a cursor
  // would strand pointers for however long a full pass takes.
  const stalePointers = await prisma.user.findMany({
    where: {
      ...reachable,
      status: { not: "active" },
      statusMessageId: { not: null },
    },
    take: STALE_POINTERS_PER_TICK,
    select,
  });

  const users = [...activeUsers, ...stalePointers];
  const result: StatusTimerResult = {
    eligible: activeUsers.length,
    tracked: activeUsers.filter((user) => user.statusMessageId !== null).length,
    created: 0,
    edited: 0,
    repinned: 0,
    removedInactive: 0,
    unchanged: 0,
    transientFailures: 0,
    permanentFailures: 0,
  };

  const stageByUser = await loadBannerStages(
    activeUsers.map((user) => user.id),
    now,
  );

  // Rematch pull entry (§3.11, §2.1 mode 5). Resolved ONCE for the whole tick,
  // not per user: this worker touches every active account every minute, and
  // the single-user eligibility check is ~3 queries.
  //
  // Short-circuited on `dropOutpacesNotices()` because only the silent-drops
  // banner renders this button. Under `weekly` — production today — that is
  // false, so this whole block costs nothing and the banner is byte-identical
  // to what it renders now. A user holding a live match is excluded twice over
  // (the stage branches win, and `filterRematchEligible` drops him anyway).
  const rematchEligible = dropOutpacesNotices()
    ? await filterRematchEligible(
        activeUsers.map((user) => user.id),
        now,
      ).catch((err: unknown) => {
        // Never let an offer lookup break the banner: it is the pinned message
        // for every active user, and the button is the least important thing on
        // it. Degrades to the ordinary menu button.
        console.warn("[status-timer] rematch eligibility failed:", err);
        return new Set<string>();
      })
    : new Set<string>();

  let actionsThisSecond = 0;
  let windowStart = Date.now();
  const takeApiSlot = async (): Promise<void> => {
    if (actionsThisSecond >= MAX_EDITS_PER_SECOND) {
      const elapsed = Date.now() - windowStart;
      if (elapsed < 1000) await sleep(1000 - elapsed);
      actionsThisSecond = 0;
      windowStart = Date.now();
    }
    actionsThisSecond++;
  };

  for (const user of users) {
    const cacheKey = String(user.telegramId);
    const retry = retryState.get(cacheKey);
    if (retry && retry.retryAt > nowMs) {
      result.unchanged++;
      continue;
    }

    if (user.status !== "active") {
      await takeApiSlot();
      try {
        await api.unpinChatMessage(
          Number(user.telegramId),
          user.statusMessageId!,
        );
        await clearInactivePointer(user.id, user.statusMessageId);
        cache.delete(cacheKey);
        retryState.delete(cacheKey);
        pinAuditAt.delete(cacheKey);
        result.removedInactive++;
      } catch (error) {
        const failure = classifyStatusBannerError(error);
        if (failure === "missing" || failure === "unreachable") {
          await clearInactivePointer(user.id, user.statusMessageId);
          cache.delete(cacheKey);
          pinAuditAt.delete(cacheKey);
          result.removedInactive++;
          if (failure === "missing") {
            retryState.delete(cacheKey);
          } else {
            recordFailure(failure, error, cacheKey, nowMs, retryState, result);
          }
        } else {
          recordFailure(failure, error, cacheKey, nowMs, retryState, result);
        }
      }
      continue;
    }

    const language: Language = user.language ?? "en";
    const stage = stageByUser.get(user.id);
    const marketPending = isMarketPending(user.profile?.homeCityKey)
      ? { city: user.profile?.homeCity ?? user.profile?.homeCityKey ?? null }
      : undefined;
    const canRematch = rematchEligible.has(user.id);
    const view = buildStatusBannerView(language, {
      now,
      ...(stage ? { stage } : {}),
      ...(marketPending ? { marketPending } : {}),
      ...(canRematch ? { rematchEligible: true } : {}),
    });

    if (user.statusMessageId === null) {
      const created = await createStatusBanner(api, user.telegramId, language, {
        now,
        ...(stage ? { stage } : {}),
        ...(marketPending ? { marketPending } : {}),
        ...(canRematch ? { rematchEligible: true } : {}),
        clearExistingPins: true,
        beforeApiCall: takeApiSlot,
      });
      if (created.kind === "created") {
        cache.set(cacheKey, created.view.signature);
        retryState.delete(cacheKey);
        pinAuditAt.set(cacheKey, nowMs);
        result.created++;
      } else if (created.kind === "already_tracked") {
        cache.set(cacheKey, created.view.signature);
        retryState.delete(cacheKey);
        pinAuditAt.set(cacheKey, 0);
        result.unchanged++;
      } else if (created.kind === "failed") {
        recordFailure(created.failure, created.error, cacheKey, nowMs, retryState, result);
      }
      continue;
    }

    const messageId = user.statusMessageId;
    const needsEdit = cache.get(cacheKey) !== view.signature;
    if (needsEdit) {
      await takeApiSlot();
      try {
        await api.editMessageText(Number(user.telegramId), messageId, view.text, {
          reply_markup: buildStatusBannerKeyboard(view),
        });
        cache.set(cacheKey, view.signature);
        retryState.delete(cacheKey);
        result.edited++;
      } catch (error) {
        if (
          error instanceof GrammyError &&
          error.description.toLowerCase().includes("message is not modified")
        ) {
          cache.set(cacheKey, view.signature);
          retryState.delete(cacheKey);
          result.unchanged++;
        } else {
          const failure = classifyStatusBannerError(error);
          if (failure === "missing") {
            await replaceMissingBanner(
              api,
              user,
              language,
              now,
              stage,
              marketPending,
              canRematch,
              view.signature,
              cache,
              retryState,
              pinAuditAt,
              result,
              takeApiSlot,
            );
          } else {
            if (failure === "unreachable") {
              await prisma.user.updateMany({
                where: { id: user.id, statusMessageId: messageId },
                data: { statusMessageId: null },
              });
              cache.delete(cacheKey);
            }
            recordFailure(failure, error, cacheKey, nowMs, retryState, result);
          }
          continue;
        }
      }
    } else {
      result.unchanged++;
    }

    const auditDue =
      options.forcePinAudit ||
      nowMs - (pinAuditAt.get(cacheKey) ?? 0) >= PIN_AUDIT_INTERVAL_MS;
    if (!auditDue) continue;

    await takeApiSlot();
    try {
      const chat = await api.getChat(Number(user.telegramId));
      if (chat.pinned_message?.message_id !== messageId) {
        await takeApiSlot();
        await api.pinChatMessage(Number(user.telegramId), messageId, {
          disable_notification: true,
        });
        result.repinned++;
      }
      pinAuditAt.set(cacheKey, nowMs);
      retryState.delete(cacheKey);
    } catch (error) {
      const failure = classifyStatusBannerError(error);
      if (failure === "missing") {
        await replaceMissingBanner(
          api,
          user,
          language,
          now,
          stage,
          marketPending,
          canRematch,
          view.signature,
          cache,
          retryState,
          pinAuditAt,
          result,
          takeApiSlot,
        );
      } else {
        recordFailure(failure, error, cacheKey, nowMs, retryState, result);
      }
    }
  }

  return result;
}

async function clearInactivePointer(
  userId: string,
  messageId: number | null,
): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, statusMessageId: messageId },
    data: { statusMessageId: null },
  });
}

async function replaceMissingBanner(
  api: Api<RawApi>,
  user: {
    id: string;
    telegramId: bigint;
    statusMessageId: number | null;
  },
  language: Language,
  now: Date,
  stage: StatusBannerStage | undefined,
  marketPending: { city: string | null } | undefined,
  // Must match what produced `signature` below, or the recreated banner and the
  // cached render disagree and the next tick re-edits a message that is already
  // correct.
  rematchEligible: boolean,
  signature: string,
  cache: Map<string, string>,
  retryState: Map<string, RetryEntry>,
  pinAuditAt: Map<string, number>,
  result: StatusTimerResult,
  beforeApiCall: () => Promise<void>,
): Promise<void> {
  const cacheKey = String(user.telegramId);
  await prisma.user.updateMany({
    where: { id: user.id, statusMessageId: user.statusMessageId },
    data: { statusMessageId: null },
  });
  const created = await createStatusBanner(api, user.telegramId, language, {
    now,
    ...(stage ? { stage } : {}),
    ...(marketPending ? { marketPending } : {}),
    ...(rematchEligible ? { rematchEligible: true } : {}),
    clearExistingPins: false,
    beforeApiCall,
  });
  if (created.kind === "created") {
    cache.set(cacheKey, signature);
    retryState.delete(cacheKey);
    pinAuditAt.set(cacheKey, now.getTime());
    result.created++;
    return;
  }
  if (created.kind === "already_tracked") {
    cache.set(cacheKey, created.view.signature);
    retryState.delete(cacheKey);
    pinAuditAt.set(cacheKey, 0);
    result.unchanged++;
    return;
  }
  if (created.kind === "failed") {
    recordFailure(
      created.failure,
      created.error,
      cacheKey,
      now.getTime(),
      retryState,
      result,
    );
  }
}

function recordFailure(
  failure: StatusBannerFailureKind,
  error: unknown,
  cacheKey: string,
  nowMs: number,
  retryState: Map<string, RetryEntry>,
  result: StatusTimerResult,
): void {
  const priorFailures = retryState.get(cacheKey)?.failures ?? 0;
  const failures = priorFailures + 1;
  const retryAfterSeconds =
    error instanceof GrammyError
      ? (error.parameters as { retry_after?: number } | undefined)?.retry_after
      : undefined;

  if (failure === "transient") {
    const exponential = Math.min(
      MAX_TRANSIENT_BACKOFF_MS,
      60_000 * 2 ** Math.min(failures - 1, 4),
    );
    retryState.set(cacheKey, {
      failures,
      retryAt: nowMs + Math.max(exponential, (retryAfterSeconds ?? 0) * 1000),
    });
    result.transientFailures++;
    return;
  }

  retryState.set(cacheKey, {
    failures,
    retryAt: nowMs + UNREACHABLE_BACKOFF_MS,
  });
  result.permanentFailures++;
}
