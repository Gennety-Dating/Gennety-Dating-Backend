import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { prisma, type MatchStatus } from "@gennety/db";
import type { Language } from "@gennety/shared";
import {
  buildStatusBannerKeyboard,
  buildStatusBannerView,
  classifyStatusBannerError,
  createStatusBanner,
  type StatusBannerFailureKind,
} from "../services/status-banner.js";
import type { StatusBannerStage } from "../services/status-banner-view.js";
import {
  ACTIVE_MATCH_STATUSES,
  pickCurrentMatch,
} from "../services/active-match-priority.js";
import { minutesLeftFromDispatch } from "../utils/countdown-plate.js";
import { isMarketPending } from "../handlers/menu/city-switch.js";

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
      // §1.1 — an account registered in a city we haven't launched gets a
      // waitlist banner instead of a countdown to a drop it can't be in.
      profile: { select: { homeCityKey: true, homeCity: true } },
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

  const stageByUser = await loadBannerStages(
    activeUsers.map((user) => user.id),
    now,
  );

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
    const view = buildStatusBannerView(language, {
      now,
      ...(stage ? { stage } : {}),
      ...(marketPending ? { marketPending } : {}),
    });

    if (user.statusMessageId === null) {
      const created = await createStatusBanner(api, user.telegramId, language, {
        now,
        ...(stage ? { stage } : {}),
        ...(marketPending ? { marketPending } : {}),
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

/** The match columns {@link resolveBannerStage} reads. */
export interface BannerStageMatch {
  status: MatchStatus;
  agreedTime: Date | null;
  venueName: string | null;
  dispatchedAt: Date | null;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
}

/**
 * Map one live match to the banner stage its participant should see
 * (PRODUCT_SPEC §2.1). `undefined` means no stage applies and the ordinary
 * next-drop countdown is the honest thing to show.
 *
 * Pure — the worker's whole product decision lives here, so it is unit-tested
 * without Prisma or grammY.
 */
export function resolveBannerStage(
  match: BannerStageMatch,
  side: "A" | "B",
  now: Date,
): StatusBannerStage | undefined {
  if (match.status === "scheduled") {
    // A date that already happened is over. The row lingers until the T+24h
    // feedback flow closes it, and by then the next drop is genuinely the
    // relevant thing again — so fall back to the drop countdown.
    if (!match.agreedTime || match.agreedTime <= now) return undefined;
    return { kind: "date", at: match.agreedTime, venueName: match.venueName };
  }

  if (match.status === "proposed") {
    const decided = side === "A" ? match.acceptedByA : match.acceptedByB;
    // A first decider leaves the row `proposed` either way (§3.4), so both
    // verdicts land here and they mean opposite things.
    if (decided === false) {
      // They passed. Nothing is being planned and nothing is owed — the row
      // just waits out the peer or the TTL. Anything else here would be a
      // banner about a date they declined.
      return undefined;
    }
    if (decided === true) {
      // Accepted, peer still silent. Deliberately says only that something is
      // in flight: the copy must never assert what the partner chose
      // (blind-decision invariant §3.4).
      return { kind: "planning" };
    }
    if (!match.dispatchedAt) return undefined;
    const minutesLeft = minutesLeftFromDispatch(match.dispatchedAt, now);
    // Past the TTL the expiry cron owns the row (it runs every 15 min), so
    // claiming there is still time to answer would be false.
    if (minutesLeft <= 0) return undefined;
    return { kind: "decision", minutesLeft };
  }

  // negotiating / negotiating_venue — the date is being arranged.
  return { kind: "planning" };
}

/**
 * Resolve every active user's banner stage in one query. A user holds at most
 * one live match (§3.2 filter 8), but legacy/corrupt rows can break that, so
 * the winner is chosen by `pickCurrentMatch` (product progression) rather than
 * by enum order — see ARCHITECTURE.md.
 */
async function loadBannerStages(
  activeUserIds: string[],
  now: Date,
): Promise<Map<string, StatusBannerStage>> {
  const stages = new Map<string, StatusBannerStage>();
  if (activeUserIds.length === 0) return stages;

  const live = await prisma.match.findMany({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [
        { userAId: { in: activeUserIds } },
        { userBId: { in: activeUserIds } },
      ],
    },
    // `pickCurrentMatch` breaks ties by input order, so the newest row within
    // a status has to come first.
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      userAId: true,
      userBId: true,
      agreedTime: true,
      venueName: true,
      dispatchedAt: true,
      acceptedByA: true,
      acceptedByB: true,
      pitchMessageIdA: true,
      pitchMessageIdB: true,
    },
  });

  const activeIds = new Set(activeUserIds);
  const candidates = new Map<
    string,
    { status: MatchStatus; match: BannerStageMatch; side: "A" | "B" }[]
  >();

  for (const match of live) {
    for (const side of ["A", "B"] as const) {
      const userId = side === "A" ? match.userAId : match.userBId;
      if (!activeIds.has(userId)) continue;
      // A proposed match becomes visible to each side only once that side's
      // own pitch was actually delivered — the same rule the My Date row uses
      // (services/active-match.ts), so the banner can't announce a match
      // mid-dispatch or one that only reached the partner.
      if (match.status === "proposed") {
        const delivered =
          side === "A" ? match.pitchMessageIdA : match.pitchMessageIdB;
        if (delivered === null) continue;
      }
      const entry = { status: match.status, match, side };
      const bucket = candidates.get(userId);
      if (bucket) bucket.push(entry);
      else candidates.set(userId, [entry]);
    }
  }

  for (const [userId, entries] of candidates) {
    const current = pickCurrentMatch(entries);
    if (!current) continue;
    const stage = resolveBannerStage(current.match, current.side, now);
    if (stage) stages.set(userId, stage);
  }

  return stages;
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
