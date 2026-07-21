import { InlineKeyboard, GrammyError, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import {
  CRON_TIMEZONE,
  getNextBatchDate,
  isWeeklyBatchProcessing,
} from "./next-batch.js";
import {
  renderStatusBanner,
  type StatusBannerUpcomingDate,
  type StatusBannerView,
} from "./status-banner-view.js";

export type StatusBannerFailureKind =
  | "missing"
  | "unreachable"
  | "transient"
  | "unknown";

export type CreateStatusBannerResult =
  | { kind: "created"; messageId: number; view: StatusBannerView }
  | { kind: "already_tracked"; messageId: number; view: StatusBannerView }
  | { kind: "skipped_mobile" }
  | { kind: "failed"; failure: StatusBannerFailureKind; error: unknown };

export interface CreateStatusBannerOptions {
  now?: Date;
  upcomingDate?: StatusBannerUpcomingDate;
  clearExistingPins?: boolean;
  beforeApiCall?: () => Promise<void>;
}

const creationLocks = new Map<string, Promise<void>>();

export function buildStatusBannerKeyboard(view: StatusBannerView): InlineKeyboard {
  return new InlineKeyboard()
    .text(view.buttonText, view.callbackData)
    .primary();
}

export function buildStatusBannerView(
  language: Language,
  now: Date = new Date(),
  upcomingDate?: StatusBannerUpcomingDate,
): StatusBannerView {
  return renderStatusBanner({
    now,
    nextDropAt: getNextBatchDate(now),
    isProcessing: isWeeklyBatchProcessing(now),
    language,
    timeZone: CRON_TIMEZONE,
    ...(upcomingDate ? { upcomingDate } : {}),
  });
}

export function classifyStatusBannerError(err: unknown): StatusBannerFailureKind {
  if (!(err instanceof GrammyError)) return "transient";
  const desc = err.description.toLowerCase();
  if (
    desc.includes("message to edit not found") ||
    desc.includes("message to pin not found") ||
    desc.includes("message not found") ||
    desc.includes("message can't be edited") ||
    desc.includes("message_id_invalid")
  ) {
    return "missing";
  }
  if (
    err.error_code === 403 ||
    desc.includes("chat not found") ||
    desc.includes("bot was blocked")
  ) {
    return "unreachable";
  }
  if (err.error_code === 429 || err.error_code >= 500) return "transient";
  return "unknown";
}

/**
 * Create, pin and persist a complete status banner. If persistence fails after
 * Telegram accepted the message, compensate by unpinning and deleting that
 * exact message so a DB outage can never create another orphan.
 */
export async function createStatusBanner(
  api: Api<RawApi>,
  telegramId: bigint,
  language: Language,
  options: CreateStatusBannerOptions = {},
): Promise<CreateStatusBannerResult> {
  if (telegramId <= 0n) return { kind: "skipped_mobile" };

  return withCreationLock(telegramId, () =>
    createStatusBannerLocked(api, telegramId, language, options),
  ).catch((error) => {
    console.warn("[status-banner] pre-create check failed:", (error as Error).message);
    return {
      kind: "failed" as const,
      failure: classifyStatusBannerError(error),
      error,
    };
  });
}

async function createStatusBannerLocked(
  api: Api<RawApi>,
  telegramId: bigint,
  language: Language,
  options: CreateStatusBannerOptions,
): Promise<CreateStatusBannerResult> {
  const view = buildStatusBannerView(
    language,
    options.now ?? new Date(),
    options.upcomingDate,
  );
  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: { statusMessageId: true },
  });
  if (existing?.statusMessageId) {
    return {
      kind: "already_tracked",
      messageId: existing.statusMessageId,
      view,
    };
  }

  const chatId = Number(telegramId);
  let messageId: number | null = null;

  try {
    if (options.clearExistingPins ?? true) {
      await options.beforeApiCall?.();
      await api.unpinAllChatMessages(chatId).catch((err) => {
        console.warn("[status-banner] stale-pin cleanup failed:", (err as Error).message);
      });
    }

    await options.beforeApiCall?.();
    const message = await api.sendMessage(chatId, view.text, {
      reply_markup: buildStatusBannerKeyboard(view),
    });
    messageId = message.message_id;
    await options.beforeApiCall?.();
    await api.pinChatMessage(chatId, messageId, { disable_notification: true });
    await prisma.user.update({
      where: { telegramId },
      data: { statusMessageId: messageId },
    });
    return { kind: "created", messageId, view };
  } catch (error) {
    if (messageId !== null) {
      await options.beforeApiCall?.();
      await api.unpinChatMessage(chatId, messageId).catch(() => {});
      await options.beforeApiCall?.();
      await api.deleteMessage(chatId, messageId).catch(() => {});
    }
    console.warn("[status-banner] create failed:", (error as Error).message);
    return { kind: "failed", failure: classifyStatusBannerError(error), error };
  }
}

async function withCreationLock<T>(
  telegramId: bigint,
  task: () => Promise<T>,
): Promise<T> {
  const key = String(telegramId);
  const previous = creationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  creationLocks.set(key, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (creationLocks.get(key) === queued) creationLocks.delete(key);
  }
}

/** Idempotent activation entrypoint; the worker maintains it after creation. */
export async function pinStatusBanner(
  api: Api<RawApi>,
  telegramId: bigint,
  language: Language,
  now: Date = new Date(),
): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: { statusMessageId: true },
  });
  if (existing?.statusMessageId || telegramId <= 0n) return;
  await createStatusBanner(api, telegramId, language, { now });
}

/** Remove any physical pin left by a deleted account before re-registration. */
export async function clearStaleStatusPins(
  api: Api<RawApi>,
  telegramId: bigint,
): Promise<void> {
  if (telegramId <= 0n) return;
  await api.unpinAllChatMessages(Number(telegramId)).catch((err) => {
    console.warn("[status-banner] re-registration cleanup failed:", (err as Error).message);
  });
}

/** Best-effort exact-pin cleanup for account deletion. */
export async function unpinKnownStatusBanner(
  api: Api<RawApi>,
  telegramId: bigint,
  messageId: number | null,
): Promise<void> {
  if (telegramId <= 0n || messageId === null) return;
  await api.unpinChatMessage(Number(telegramId), messageId).catch((err) => {
    console.warn("[status-banner] exact unpin failed:", (err as Error).message);
  });
}

/** Remove the banner for a user leaving the active matching pool. */
export async function unpinStatusBanner(
  api: Api<RawApi>,
  telegramId: bigint,
): Promise<void> {
  if (telegramId <= 0n) return;
  await api.unpinAllChatMessages(Number(telegramId)).catch((err) => {
    console.warn("[status-banner] unpin failed:", (err as Error).message);
  });
  await prisma.user
    .update({ where: { telegramId }, data: { statusMessageId: null } })
    .catch(() => {});
}
