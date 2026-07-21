import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import {
  buildStatusBannerKeyboard,
  buildStatusBannerView,
  classifyStatusBannerError,
  createStatusBanner,
  type StatusBannerFailureKind,
} from "../services/status-banner.js";

const MAX_EDITS_PER_SECOND = 25;
const PIN_AUDIT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRANSIENT_BACKOFF_MS = 15 * 60 * 1000;
const UNREACHABLE_BACKOFF_MS = 6 * 60 * 60 * 1000;

interface RetryEntry {
  failures: number;
  retryAt: number;
}

export interface StatusTimerOptions {
  now?: Date;
  renderCache?: Map<string, string>;
  retryState?: Map<string, RetryEntry>;
  pinAuditAt?: Map<string, number>;
  forcePinAudit?: boolean;
  sleep?: (ms: number) => Promise<void>;
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

const defaultCache = new Map<string, string>();
const defaultRetryState = new Map<string, RetryEntry>();
const defaultPinAuditAt = new Map<string, number>();
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function statusTimerTick(
  api: Api<RawApi>,
  options: StatusTimerOptions = {},
): Promise<StatusTimerResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const cache = options.renderCache ?? defaultCache;
  const retryState = options.retryState ?? defaultRetryState;
  const pinAuditAt = options.pinAuditAt ?? defaultPinAuditAt;
  const sleep = options.sleep ?? defaultSleep;

  // Active rows are reconciled even when the pointer is null. Non-active rows
  // are selected only when a stale pointer still needs cleanup.
  const users = await prisma.user.findMany({
    where: {
      telegramId: { gt: 0n },
      platform: { in: ["telegram", "both"] },
      OR: [{ status: "active" }, { statusMessageId: { not: null } }],
    },
    select: {
      id: true,
      telegramId: true,
      language: true,
      status: true,
      statusMessageId: true,
    },
  });

  const activeUsers = users.filter((user) => user.status === "active");
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

  const dateByUser = new Map<string, { at: Date; venueName: string | null }>();
  if (activeUsers.length > 0) {
    const scheduled = await prisma.match.findMany({
      where: {
        status: "scheduled",
        agreedTime: { gt: now },
        OR: [
          { userAId: { in: activeUsers.map((user) => user.id) } },
          { userBId: { in: activeUsers.map((user) => user.id) } },
        ],
      },
      select: { userAId: true, userBId: true, agreedTime: true, venueName: true },
    });
    for (const match of scheduled) {
      if (!match.agreedTime) continue;
      for (const userId of [match.userAId, match.userBId]) {
        const existing = dateByUser.get(userId);
        if (!existing || match.agreedTime < existing.at) {
          dateByUser.set(userId, {
            at: match.agreedTime,
            venueName: match.venueName,
          });
        }
      }
    }
  }

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
    const upcomingDate = dateByUser.get(user.id);
    const view = buildStatusBannerView(language, now, upcomingDate);

    if (user.statusMessageId === null) {
      const created = await createStatusBanner(api, user.telegramId, language, {
        now,
        ...(upcomingDate ? { upcomingDate } : {}),
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
              upcomingDate,
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
          upcomingDate,
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
  upcomingDate: { at: Date; venueName: string | null } | undefined,
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
    ...(upcomingDate ? { upcomingDate } : {}),
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
